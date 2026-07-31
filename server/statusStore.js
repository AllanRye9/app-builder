import { promises as fs } from 'fs';
import path from 'path';

// Render runs this as one long-lived process (unlike Vercel Functions,
// which are stateless per-invocation), so a plain in-memory Map is enough
// for status lookups within a single process lifetime. We also mirror
// every write to disk under DATA_DIR so status survives a redeploy/restart
// as long as DATA_DIR points at a persistent disk — and still works fine
// (just loses in-flight jobs on restart) if it doesn't.
const store = new Map();

let statusDir = null;
export function initStatusStore(dataDir) {
  statusDir = path.join(dataDir, 'status');
  return fs.mkdir(statusDir, { recursive: true });
}

function filePath(jobId) {
  return path.join(statusDir, `${jobId}.json`);
}

export async function writeStatus(jobId, patch) {
  const existing = store.get(jobId) || {};
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  store.set(jobId, merged);
  try {
    await fs.writeFile(filePath(jobId), JSON.stringify(merged));
  } catch {
    // Disk mirror is best-effort — in-memory store is still authoritative
    // for the lifetime of this process.
  }
  return merged;
}

export async function readStatus(jobId) {
  if (store.has(jobId)) return store.get(jobId);
  try {
    const raw = await fs.readFile(filePath(jobId), 'utf8');
    const parsed = JSON.parse(raw);
    store.set(jobId, parsed);
    return parsed;
  } catch {
    return null;
  }
}
