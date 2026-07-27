'use strict';

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'apk-builder-image';
const MAX_CONCURRENT_BUILDS = parseInt(process.env.MAX_CONCURRENT_BUILDS || '1', 10);
const BUILD_MEMORY_LIMIT = process.env.BUILD_MEMORY_LIMIT || '2g';
const BUILD_CPU_LIMIT = process.env.BUILD_CPU_LIMIT || '2';
const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS || `${15 * 60 * 1000}`, 10); // 15 min
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || `${150 * 1024 * 1024}`, 10); // 150MB
const JOB_ROOT = process.env.JOB_ROOT || path.join(os.tmpdir(), 'apk-builder-jobs');
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || `${60 * 60 * 1000}`, 10); // 1 hour retention

fs.mkdirSync(JOB_ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// In-memory job store + event bus (swap for Redis/DB if you need multi-instance)
// ---------------------------------------------------------------------------
const jobs = new Map(); // jobId -> job record
const bus = new EventEmitter();
bus.setMaxListeners(0);

function createJob() {
  const id = uuidv4();
  const dir = path.join(JOB_ROOT, id);
  const record = {
    id,
    status: 'queued', // queued -> validating -> building -> success | failed
    logs: [],
    error: null,
    createdAt: Date.now(),
    dir,
    projectDir: path.join(dir, 'project'),
    outputDir: path.join(dir, 'output'),
    apkPath: null,
  };
  jobs.set(id, record);
  return record;
}

function log(job, line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  job.logs.push(entry);
  bus.emit(`log:${job.id}`, entry);
}

function setStatus(job, status, error) {
  job.status = status;
  if (error) job.error = error;
  bus.emit(`status:${job.id}`, { status, error: job.error });
  if (status === 'success' || status === 'failed') {
    bus.emit(`done:${job.id}`, { status, error: job.error });
  }
}

// ---------------------------------------------------------------------------
// Cleanup: wipe a job's workspace, in-memory record, and log/event history
// ---------------------------------------------------------------------------
function purgeJob(job) {
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  job.logs = [];
  job.apkPath = null;
  bus.removeAllListeners(`log:${job.id}`);
  bus.removeAllListeners(`status:${job.id}`);
  bus.removeAllListeners(`done:${job.id}`);
  jobs.delete(job.id);
}

// Fallback sweep for jobs nobody ever downloaded (browser closed, crash, etc).
setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (now - job.createdAt > JOB_TTL_MS) purgeJob(job);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Zip validation & safe extraction
// ---------------------------------------------------------------------------
const FORBIDDEN_TOP_LEVEL = new Set([
  'android', 'ios', 'platforms', 'capacitor.config.json', 'capacitor.config.ts',
]);

// Only allow project-source-like file extensions through. Anything else in
// the archive causes rejection rather than silent stripping, so the user
// knows exactly why a build was refused.
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.md', '.mjs', '.cjs', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.txt',
  '.env.example', '.gitignore', '.npmrc', '.yml', '.yaml', '.lock',
]);

function isSafeEntryName(name) {
  // Reject absolute paths, zip-slip traversal, and null bytes.
  if (name.includes('\0')) return false;
  const normalized = path.normalize(name);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  return true;
}

function validateAndExtract(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length === 0) {
    throw new ValidationError('The archive is empty.');
  }

  let hasPackageJson = false;

  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, '/');

    if (!isSafeEntryName(entryName)) {
      throw new ValidationError(`Unsafe path in archive: ${entryName}`);
    }

    const parts = entryName.split('/').filter(Boolean);
    const topLevel = parts[0] ? parts[0].toLowerCase() : '';

    if (FORBIDDEN_TOP_LEVEL.has(topLevel)) {
      throw new ValidationError(
        `Archive already contains "${parts[0]}". Upload a plain React project — native platform folders are generated by the build.`
      );
    }

    if (entryName === 'package.json' || entryName.endsWith('/package.json')) {
      // Only trust a package.json at the project root (depth 0 or 1 if the
      // zip wraps everything in a single top folder).
      if (parts.length <= 2) hasPackageJson = true;
    }

    if (!entry.isDirectory) {
      const ext = path.extname(entryName).toLowerCase();
      if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
        throw new ValidationError(`Disallowed file type in archive: ${entryName}`);
      }
    }
  }

  if (!hasPackageJson) {
    throw new ValidationError('No package.json found at the project root.');
  }

  fs.mkdirSync(destDir, { recursive: true });
  zip.extractAllTo(destDir, true);

  // If the zip wrapped everything in a single top-level folder, flatten it
  // so package.json ends up directly inside destDir.
  const rootEntries = fs.readdirSync(destDir);
  if (rootEntries.length === 1) {
    const onlyPath = path.join(destDir, rootEntries[0]);
    if (fs.statSync(onlyPath).isDirectory() && fs.existsSync(path.join(onlyPath, 'package.json'))) {
      for (const child of fs.readdirSync(onlyPath)) {
        fs.renameSync(path.join(onlyPath, child), path.join(destDir, child));
      }
      fs.rmSync(onlyPath, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(path.join(destDir, 'package.json'))) {
    throw new ValidationError('package.json not found after extraction.');
  }
}

class ValidationError extends Error {}

// ---------------------------------------------------------------------------
// Build queue (bounded concurrency)
// ---------------------------------------------------------------------------
const queue = [];
let running = 0;

function enqueue(job) {
  queue.push(job);
  log(job, `Queued (position ${queue.length}).`);
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT_BUILDS && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    runBuild(job).finally(() => {
      running -= 1;
      pump();
    });
  }
}

function runBuild(job) {
  return new Promise((resolve) => {
    fs.mkdirSync(job.outputDir, { recursive: true });
    setStatus(job, 'building');
    log(job, `Starting Docker build (image: ${DOCKER_IMAGE}).`);

    const args = [
      'run', '--rm',
      '--memory', BUILD_MEMORY_LIMIT,
      '--cpus', BUILD_CPU_LIMIT,
      // Note: the build needs network access (npm install, Gradle/SDK
      // downloads), so we can't run with --network none. Isolation instead
      // comes from the container being ephemeral (--rm), resource-capped,
      // and torn down after each job — never re-run inside a live container.
      '-v', `${job.projectDir}:/project`,
      '-v', `${job.outputDir}:/output`,
      DOCKER_IMAGE,
    ];

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timeout = setTimeout(() => {
      log(job, `Build exceeded ${Math.round(BUILD_TIMEOUT_MS / 1000)}s timeout — killing container.`);
      child.kill('SIGKILL');
    }, BUILD_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => log(job, l));
    });
    child.stderr.on('data', (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => log(job, l));
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      setStatus(job, 'failed', `Failed to start Docker: ${err.message}`);
      log(job, `ERROR: ${err.message}`);
      resolve();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const apkPath = path.join(job.outputDir, 'app.apk');
      if (code === 0 && fs.existsSync(apkPath)) {
        job.apkPath = apkPath;
        log(job, 'Build succeeded. APK is ready for download.');
        setStatus(job, 'success');
      } else {
        setStatus(job, 'failed', `Build process exited with code ${code}.`);
        log(job, `Build failed (exit code ${code}).`);
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({
  dest: path.join(JOB_ROOT, '_uploads'),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

app.post('/api/upload', upload.single('zip'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Field name must be "zip".' });
  }
  if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Only .zip archives are accepted.' });
  }

  const job = createJob();
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
      return res.status(202).json({ jobId: job.id }); // still trackable via status endpoint
    }
    setStatus(job, 'failed', 'Unexpected server error during validation.');
    log(job, `ERROR: ${err.message}`);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    logs: job.logs,
    downloadReady: job.status === 'success' && !!job.apkPath,
  });
});

// Live log stream via Server-Sent Events
app.get('/api/logs/:jobId/stream', (req, res) => {
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
  res.write(`event: status\ndata: ${JSON.stringify({ status: job.status })}\n\n`);

  const onLog = (line) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  const onStatus = (payload) => res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  const onDone = (payload) => {
    res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    cleanupListeners();
    res.end();
  };

  function cleanupListeners() {
    bus.off(`log:${job.id}`, onLog);
    bus.off(`status:${job.id}`, onStatus);
    bus.off(`done:${job.id}`, onDone);
  }

  bus.on(`log:${job.id}`, onLog);
  bus.on(`status:${job.id}`, onStatus);
  bus.on(`done:${job.id}`, onDone);

  req.on('close', cleanupListeners);
});

app.get('/api/download/:jobId', (req, res) => {
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

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Archive exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`APK builder listening on http://localhost:${PORT}`);
  console.log(`Docker image: ${DOCKER_IMAGE} | max concurrent builds: ${MAX_CONCURRENT_BUILDS}`);
});
