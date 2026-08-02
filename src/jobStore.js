'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { JOB_ROOT, JOB_TTL_MS } = require('./config');

fs.mkdirSync(JOB_ROOT, { recursive: true });

const jobs = new Map(); // jobId -> job record
const bus = new EventEmitter();
bus.setMaxListeners(0);

function createJob(filename, permissions) {
  const id = uuidv4();
  const dir = path.join(JOB_ROOT, id);
  const record = {
    id,
    filename: filename || 'project.zip',
    status: 'queued', // queued -> validating -> building -> success | failed
    queuePosition: null,
    logs: [],
    notices: [],
    error: null,
    createdAt: Date.now(),
    dir,
    projectDir: path.join(dir, 'project'),
    outputDir: path.join(dir, 'output'),
    apkPath: null,
    // Fine-grained progress within the 'building' macro-status — see
    // setStep() below. Distinct from `status` (which the Pipeline stepper
    // uses for its 4 big stages): this drives the in-progress detail line
    // and percentage bar inside the 'Build' stage itself, e.g. "Installing
    // dependencies (cache hit)" at 20% vs "Compiling APK with Gradle" at
    // 70%, so the dashboard can show real signal instead of one static
    // "Build" label sitting there for however many minutes Gradle takes.
    step: null,
    stepProgress: 0,
    // Chosen by whoever uploaded the project — never invented by the build
    // itself. See src/permissions.js for the whitelist/sanitizer and
    // src/buildRunner.js for where these actually get applied.
    permissions: Array.isArray(permissions) ? permissions : [],
    // Set once validate.js has inspected the extracted project
    // ('capacitor-web' or 'native-android'); null until then.
    projectType: null,
  };
  jobs.set(id, record);
  return record;
}

function log(job, line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  job.logs.push(entry);
  bus.emit(`log:${job.id}`, entry);
}

// notice(): a structured, UI-visible event — distinct from a plain log line.
// Emitted when the build dynamically decided or fixed something (matched a
// package version, installed a missing dependency, patched a config) so the
// frontend can surface it as a pop-up instead of leaving it buried in logs.
function notice(job, payload) {
  const entry = {
    level: payload.level || 'info',
    title: payload.title || '',
    message: payload.message || '',
    at: new Date().toISOString(),
  };
  job.notices.push(entry);
  bus.emit(`notice:${job.id}`, entry);
}

// How many builds are ahead of this one. Recomputed for every waiting job
// each time the queue changes (see buildRunner.js's pump()), so a job
// that's been waiting sees its position count down in real time instead of
// a single static "queued" label — meaningful once several builds can be
// in flight and several more waiting behind them.
function setQueuePosition(job, position) {
  job.queuePosition = position;
  bus.emit(`queue:${job.id}`, { position });
}

// label: short human-readable description of what's happening right now.
// progress: 0-100, monotonic within a single build's 'building' status.
// meta: optional extra flags for the UI, e.g. { cacheHit: true } so a
// dependency-cache hit can be badged distinctly from a normal install.
function setStep(job, label, progress, meta) {
  job.step = label;
  job.stepProgress = progress;
  const payload = { step: label, progress, ...(meta || {}) };
  bus.emit(`step:${job.id}`, payload);
}

function setStatus(job, status, error) {
  job.status = status;
  if (error) job.error = error;
  bus.emit(`status:${job.id}`, { status, error: job.error });
  if (status === 'success' || status === 'failed') {
    bus.emit(`done:${job.id}`, { status, error: job.error });
  }
}

function purgeJob(job) {
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  job.logs = [];
  job.notices = [];
  job.apkPath = null;
  bus.removeAllListeners(`log:${job.id}`);
  bus.removeAllListeners(`notice:${job.id}`);
  bus.removeAllListeners(`status:${job.id}`);
  bus.removeAllListeners(`queue:${job.id}`);
  bus.removeAllListeners(`step:${job.id}`);
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

module.exports = { jobs, bus, createJob, log, notice, setStatus, setStep, setQueuePosition, purgeJob };
