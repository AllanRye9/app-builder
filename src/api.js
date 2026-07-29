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
    const hint = await diagnoseBlobUploadFailure();
    throw new Error(`Upload failed: ${err.message}${hint ? ` — ${hint}` : ''}`);
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

// The Blob client SDK's own error ("Failed to retrieve the client token")
// doesn't say *why* — it fires the same way whether the route doesn't exist
// at all, or exists but couldn't generate a token. A GET to the same route
// (which our handler always rejects with 405, since it only accepts POST)
// tells these two apart without needing to replicate the SDK's internal
// token-request protocol.
async function diagnoseBlobUploadFailure() {
  try {
    const res = await fetch('/api/blob-upload', { method: 'GET' });
    const text = await res.text();
    if (res.status === 404 || /<!doctype html/i.test(text)) {
      return "the /api/blob-upload function doesn't seem to be deployed here — check the Vercel project's Root Directory setting.";
    }
    if (res.status === 405) {
      return 'the route exists and responded, so this is most likely a missing or unattached Blob store — check the Storage tab, confirm BLOB_READ_WRITE_TOKEN is set in Environment Variables, and redeploy after adding it (env vars only apply to deployments made after they were set).';
    }
    return `diagnostic check got HTTP ${res.status}.`;
  } catch {
    return null;
  }
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
