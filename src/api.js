import { upload } from '@vercel/blob/client';

// Uploads straight to Blob storage from the browser (via a short-lived
// signed token from /api/blob-upload), then tells the backend to dispatch
// the GitHub Actions build. Returns the new job id.
export async function uploadAndStartBuild(file) {
  let blob;
  try {
    blob = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/blob-upload',
    });
  } catch (err) {
    throw new Error(`Upload failed: ${err.message}`);
  }

  const res = await fetch('/api/start-build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blobUrl: blob.url, filename: file.name }),
  });

  const bodyText = await res.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`Couldn't start the build: server returned HTTP ${res.status} (not JSON).`);
  }

  if (!res.ok) {
    throw new Error(data.error || `Couldn't start the build (HTTP ${res.status}).`);
  }
  return data.jobId;
}

// No long-lived connection to hold open here — GitHub Actions runs happen
// on infrastructure this app doesn't control the lifetime of, so polling a
// small stateless status endpoint is the right fit, not SSE.
export function pollStatus(jobId, { onUpdate, onDone }, intervalMs = 3000) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(`/api/status?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        onUpdate?.(data);
        if (data.status === 'success' || data.status === 'failed') {
          onDone?.(data);
          return; // stop polling — terminal state
        }
      }
    } catch {
      // Transient network hiccup — just try again next tick.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
