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

function createJob() {
  const id = uuidv4();
  const dir = path.join(JOB_ROOT, id);
  const record = {
    id,
    status: 'queued', // queued -> validating -> building -> success | failed
    logs: [],
    notices: [],
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

module.exports = { jobs, bus, createJob, log, notice, setStatus, purgeJob };
