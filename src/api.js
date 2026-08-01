// Checks whether the server has everything it needs (GITHUB_TOKEN,
// GITHUB_OWNER, GITHUB_REPO, CALLBACK_SECRET, and a writable storage
// directory) so the UI can show a clear setup banner up front, instead of
// people only finding out something's missing after their first upload
// fails.
export async function fetchServerConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Uploads the project zip directly to this app's own server (a real,
// long-running process — not a stateless Function with a 4.5MB body cap),
// which saves it, kicks off the GitHub Actions build, and returns a job id.
// Used when /api/config reports storageMode: 'disk' (Render/Railway/Fly/
// plain Docker, or Vercel without a Blob store attached).
async function uploadAndStartBuildViaDisk(file) {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/upload-and-start', {
    method: 'POST',
    body: formData,
  });

  const bodyText = await res.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`Couldn't start the build: server returned HTTP ${res.status} (not JSON).`);
  }

  if (!res.ok) {
    throw new Error(data.detail || data.error || `Couldn't start the build (HTTP ${res.status}).`);
  }
  return data.jobId;
}

// Uploads the project zip straight from the browser to Vercel Blob storage
// — the file never passes through this app's server/Function at all, which
// is what makes this work on Vercel despite its 4.5MB request body cap.
// Used when /api/config reports storageMode: 'blob'.
async function uploadAndStartBuildViaBlob(file, onProgress) {
  // Imported dynamically so this (and its dependency chain) is only
  // pulled into the bundle for people actually on a Blob-mode deployment.
  const { upload } = await import('@vercel/blob/client');

  let blob;
  try {
    blob = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/blob-upload-token',
      onUploadProgress: onProgress
        ? (event) => onProgress(event.percentage)
        : undefined,
    });
  } catch (err) {
    throw new Error(
      `Upload failed: ${err.message || err} — if this mentions a missing/unattached Blob store, ` +
        "check the Storage tab, confirm BLOB_READ_WRITE_TOKEN is set in Environment Variables, " +
        'and redeploy after adding it (env vars only apply to deployments made after they were set).'
    );
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
    throw new Error(data.detail || data.error || `Couldn't start the build (HTTP ${res.status}).`);
  }
  return data.jobId;
}

// Picks the right upload path based on what the server reports it's set up
// for (see /api/config's storageMode) — callers don't need to know which
// one is in play.
export async function uploadAndStartBuild(file, { serverConfig, onProgress } = {}) {
  if (serverConfig?.storageMode === 'blob') {
    return uploadAndStartBuildViaBlob(file, onProgress);
  }
  return uploadAndStartBuildViaDisk(file);
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
