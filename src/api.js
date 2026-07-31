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
export async function uploadAndStartBuild(file) {
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
