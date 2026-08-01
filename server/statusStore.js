// --- Job status store ----------------------------------------------------
//
// The previous GitHub Actions edition mirrored every status write to disk
// under DATA_DIR so status survived a redeploy/restart on platforms with a
// persistent disk. That concept no longer applies: this edition has no
// persistent dataDir at all — every job's upload, build output, and status
// are ephemeral by design and get deleted automatically a fixed number of
// minutes after the build finishes (see RETENTION_MINUTES / scheduleCleanup
// in server/index.js). A plain in-memory Map for the lifetime of this
// single long-running process is the correct fit for that model: if the
// process restarts, any in-flight job's build container is gone with it
// anyway (this server no longer relies on an external system that could
// finish independently of it, unlike the old GitHub Actions runner).
const store = new Map();

export async function writeStatus(jobId, patch) {
  const existing = store.get(jobId) || {};
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  store.set(jobId, merged);
  return merged;
}

export async function readStatus(jobId) {
  return store.has(jobId) ? store.get(jobId) : null;
}

export async function deleteStatus(jobId) {
  store.delete(jobId);
}
