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

  const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Upload failed.');
  }
  return data.jobId;
}

export function streamLogs(jobId, { onLog, onNotice, onStatus, onDone }) {
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
