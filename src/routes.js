'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { MAX_UPLOAD_BYTES, JOB_ROOT, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } = require('./config');
const { jobs, bus, createJob, log, notice, setStatus, purgeJob } = require('./jobStore');
const { validateAndExtract, ValidationError } = require('./validate');
const { enqueue } = require('./dockerRunner');

const router = express.Router();

const upload = multer({
  dest: path.join(JOB_ROOT, '_uploads'),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ---------------------------------------------------------------------------
// Minimal per-IP rate limiter for the upload endpoint
// ---------------------------------------------------------------------------
// Each Docker build is expensive (CPU/memory-capped, but still real work),
// so an open upload endpoint needs a basic abuse guard. This is a small,
// dependency-free sliding-window counter — enough for a single-instance
// worker. It is deliberately simple: swap for a real rate limiter (or push
// this to a reverse proxy) if this ever runs as multiple instances behind a
// load balancer, since this state is per-process.
const uploadHits = new Map(); // ip -> array of timestamps (ms)

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const hits = (uploadHits.get(ip) || []).filter((t) => t > windowStart);

  if (hits.length >= RATE_LIMIT_MAX) {
    const retryAfterMs = hits[0] + RATE_LIMIT_WINDOW_MS - now;
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({
      error: `Too many builds started from this connection. Try again in ${Math.ceil(retryAfterMs / 60000)} min.`,
    });
  }

  hits.push(now);
  uploadHits.set(ip, hits);
  next();
}

// Sweep stale IP entries so this Map doesn't grow unbounded under sustained
// high-volume traffic.
setInterval(() => {
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, hits] of uploadHits) {
    const kept = hits.filter((t) => t > windowStart);
    if (kept.length === 0) uploadHits.delete(ip);
    else uploadHits.set(ip, kept);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

router.post('/upload', rateLimit, upload.single('zip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Field name must be "zip".' });
  }
  if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Only .zip archives are accepted.' });
  }

  const job = createJob(req.file.originalname);
  setStatus(job, 'validating');
  log(job, `Received ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB).`);

  try {
    validateAndExtract(req.file.path, job.projectDir);
    log(job, 'Validation passed: plain React/Capacitor-ready project detected.');
    fs.unlink(req.file.path, () => {});
    enqueue(job);
    return res.status(202).json({ jobId: job.id });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    if (err instanceof ValidationError) {
      setStatus(job, 'failed', err.message);
      log(job, `Validation failed: ${err.message}`);
      notice(job, { level: 'error', title: 'Archive rejected', message: err.message });
      return res.status(202).json({ jobId: job.id }); // still trackable via status endpoint
    }
    setStatus(job, 'failed', 'Unexpected server error during validation.');
    log(job, `ERROR: ${err.message}`);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json({
    id: job.id,
    filename: job.filename,
    status: job.status,
    queuePosition: job.queuePosition,
    error: job.error,
    logs: job.logs,
    notices: job.notices,
    downloadReady: job.status === 'success' && !!job.apkPath,
  });
});

// Live log stream via Server-Sent Events
router.get('/logs/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Replay what's already happened, then stream new lines.
  job.logs.forEach((line) => res.write(`data: ${JSON.stringify(line)}\n\n`));
  job.notices.forEach((n) => res.write(`event: notice\ndata: ${JSON.stringify(n)}\n\n`));
  res.write(`event: status\ndata: ${JSON.stringify({ status: job.status, error: job.error })}\n\n`);
  if (job.queuePosition != null) {
    res.write(`event: queue\ndata: ${JSON.stringify({ position: job.queuePosition })}\n\n`);
  }

  // A job can already be terminal by the time the client connects — e.g. an
  // archive that fails validation goes straight to 'failed' synchronously,
  // before the browser even opens this stream. Without this, that client
  // would never see a 'done' event (it already fired once, before anyone
  // was listening) and would be stuck showing "queued" forever with no
  // error surfaced and no completion notification. Same fix also makes a
  // reconnect/second tab work correctly for any already-finished job.
  if (job.status === 'success' || job.status === 'failed') {
    res.write(`event: done\ndata: ${JSON.stringify({ status: job.status, error: job.error })}\n\n`);
    return res.end();
  }

  const onLog = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  const onNotice = (payload) => res.write(`event: notice\ndata: ${JSON.stringify(payload)}\n\n`);
  const onStatus = (payload) => res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  const onQueue = (payload) => res.write(`event: queue\ndata: ${JSON.stringify(payload)}\n\n`);
  const onDone = (payload) => {
    res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    cleanupListeners();
    res.end();
  };

  function cleanupListeners() {
    bus.off(`log:${job.id}`, onLog);
    bus.off(`notice:${job.id}`, onNotice);
    bus.off(`status:${job.id}`, onStatus);
    bus.off(`queue:${job.id}`, onQueue);
    bus.off(`done:${job.id}`, onDone);
  }

  bus.on(`log:${job.id}`, onLog);
  bus.on(`notice:${job.id}`, onNotice);
  bus.on(`status:${job.id}`, onStatus);
  bus.on(`queue:${job.id}`, onQueue);
  bus.on(`done:${job.id}`, onDone);

  req.on('close', cleanupListeners);
});

router.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  if (job.status !== 'success' || !job.apkPath || !fs.existsSync(job.apkPath)) {
    return res.status(409).json({ error: 'APK not ready.' });
  }

  res.download(job.apkPath, 'app.apk', (err) => {
    if (err) {
      // Client aborted or the connection dropped mid-transfer — leave the
      // job intact so they can retry the download instead of losing it.
      console.error(`Download did not complete for job ${job.id}: ${err.message}`);
      return;
    }
    // Transfer finished successfully — the APK has been handed off, so wipe
    // the project source, build output, and logs for this job immediately
    // rather than waiting for the TTL sweep.
    purgeJob(job);
  });
});

module.exports = router;
