import { EventEmitter } from 'events';

// --- Job store -------------------------------------------------------------
// Plain in-memory store, one process. Jobs are ephemeral by design (see
// config.js's RETENTION_MINUTES) so there's no need for this to survive a
// restart — an in-flight build's container dies with this process anyway.
const jobs = new Map(); // jobId -> { id, filename, status, error, queuePosition, apkFilename, createdAt }
const emitters = new Map(); // jobId -> EventEmitter, for live SSE subscribers
const histories = new Map(); // jobId -> array of {event, data} in order, replayed to a client that connects late

// A build can finish (or even fail validation) before the browser's
// EventSource for it ever connects — uploadZip() resolving and the
// dashboard mounting JobTicket (which opens the stream) aren't atomic. Every
// event is recorded here in order and replayed in full to a new subscriber
// before it starts receiving live ones, so no client ever "misses" events
// that happened before it connected — see src/index.js's SSE route.
const MAX_HISTORY_PER_JOB = 5000;

export function createJob(jobId, { filename }) {
  jobs.set(jobId, {
    id: jobId,
    filename,
    status: 'validating',
    error: null,
    queuePosition: null,
    apkFilename: null,
    createdAt: Date.now(),
  });
  emitters.set(jobId, new EventEmitter().setMaxListeners(0));
  histories.set(jobId, []);
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function record(jobId, event, data) {
  const history = histories.get(jobId);
  if (!history) return; // job already cleaned up
  history.push({ event, data });
  if (history.length > MAX_HISTORY_PER_JOB) history.shift();
  emitters.get(jobId)?.emit('event', { event, data });
}

export function emitLog(jobId, line) {
  record(jobId, 'message', line);
}

export function emitNotice(jobId, notice) {
  record(jobId, 'notice', notice);
}

export function emitQueuePosition(jobId, position) {
  const job = jobs.get(jobId);
  if (job) job.queuePosition = position;
  record(jobId, 'queue', { position });
}

export function setStatus(jobId, status, error = null) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = status;
    job.error = error;
  }
  record(jobId, 'status', { status, error });
}

export function finishJob(jobId, status, error = null, { apkFilename } = {}) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = status;
    job.error = error;
    job.queuePosition = null;
    if (apkFilename) job.apkFilename = apkFilename;
  }
  record(jobId, 'done', { status, error });
}

// Subscribes a new SSE client: replays everything that already happened for
// this job, then calls `onEvent` for everything that happens from now on.
// Returns an unsubscribe function.
export function subscribe(jobId, onEvent) {
  const history = histories.get(jobId) || [];
  for (const { event, data } of history) onEvent({ event, data });

  const emitter = emitters.get(jobId);
  if (!emitter) return () => {};
  const handler = (payload) => onEvent(payload);
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}

export function deleteJob(jobId) {
  jobs.delete(jobId);
  emitters.get(jobId)?.removeAllListeners();
  emitters.delete(jobId);
  histories.delete(jobId);
}
