import { put, list } from '@vercel/blob';

const PREFIX = 'status/';

// Vercel Functions are stateless — nothing kept in memory here survives
// between one invocation and the next, let alone between the function that
// starts a build and the GitHub Actions runner that reports back on it
// minutes later. This uses the same Blob store as uploads as a minimal
// key-value store: one small JSON object per job, read on every /api/status
// poll and overwritten (not appended) on every update.
export async function writeStatus(jobId, patch) {
  const existing = (await readStatus(jobId)) || {};
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await put(`${PREFIX}${jobId}.json`, JSON.stringify(merged), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    // This blob's URL never changes but its content does, repeatedly, as a
    // job progresses — the opposite of what long-lived caching assumes.
    // Without this, a cached response could make polling look frozen.
    cacheControlMaxAge: 0,
  });
  return merged;
}

export async function readStatus(jobId) {
  const { blobs } = await list({ prefix: `${PREFIX}${jobId}.json`, limit: 1 });
  if (blobs.length === 0) return null;
  const res = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}
