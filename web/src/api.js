// API_BASE lets the frontend be hosted separately from the build worker —
// e.g. this React app on Vercel/Netlify/any static host, while the actual
// Docker build worker runs on a VPS/Fly.io/Railway/Render (anywhere with a
// real Docker daemon — see the root README for why Vercel itself can't run
// the worker). Leave VITE_API_BASE_URL unset for the default single-origin
// deployment (docker-compose serves both from the same host); set it to the
// worker's full origin (e.g. https://build.example.com) when split across
// two hosts. The worker must have CORS_ORIGIN set to this frontend's origin
// in that case — see src/index.js.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export async function uploadZip(file) {
  const formData = new FormData();
  formData.append('zip', file);

  let res;
  try {
    res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
  } catch {
    // fetch() itself threw: DNS failure, connection refused, or a CORS
    // preflight rejection. API_BASE being wrong/unreachable is the most
    // common cause here.
    throw new Error(
      API_BASE
        ? `Can't reach the build worker at ${API_BASE}. Check VITE_API_BASE_URL and that the worker is running.`
        : "Can't reach the API. If the frontend is deployed separately (e.g. on Vercel), set VITE_API_BASE_URL to the worker's URL."
    );
  }

  const bodyText = await res.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    // Response wasn't JSON at all — almost always means something in front
    // of the Express app answered instead of it: a reverse proxy's own 413
    // error page (body too large — see README's client_max_body_size note),
    // or, if API_BASE is unset/wrong on a split deployment, this request
    // landing on a host with no backend at all (e.g. Vercel's own 404 page).
    throw new Error(
      `Upload failed: server returned HTTP ${res.status} ${res.statusText} (not JSON) — ` +
      (res.status === 413
        ? "the file is likely being rejected by a reverse proxy before reaching the app; check its max body size."
        : `check that ${API_BASE || 'the API'} is actually the build worker, not just a static host.`)
    );
  }

  if (!res.ok) {
    throw new Error(data.error || `Upload failed: server returned HTTP ${res.status} ${res.statusText}.`);
  }
  return data.jobId;
}

export function streamLogs(jobId, { onLog, onNotice, onStatus, onQueue, onDone }) {
  const source = new EventSource(`${API_BASE}/api/logs/${jobId}/stream`);

  source.onmessage = (e) => {
    onLog?.(JSON.parse(e.data));
  };

  source.addEventListener('notice', (e) => {
    onNotice?.(JSON.parse(e.data));
  });

  source.addEventListener('status', (e) => {
    onStatus?.(JSON.parse(e.data));
  });

  source.addEventListener('queue', (e) => {
    onQueue?.(JSON.parse(e.data));
  });

  source.addEventListener('done', (e) => {
    onDone?.(JSON.parse(e.data));
    source.close();
  });

  // EventSource auto-retries on transient errors; if the job already
  // finished this fires as a harmless close, so there's nothing to do here.
  source.onerror = () => {};

  return () => source.close();
}

export function downloadUrl(jobId) {
  return `${API_BASE}/api/download/${jobId}`;
}
