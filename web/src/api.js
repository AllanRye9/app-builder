export async function uploadZip(file) {
  const formData = new FormData();
  formData.append('zip', file);

  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Upload failed.');
  }
  return data.jobId;
}

export function streamLogs(jobId, { onLog, onStatus, onDone }) {
  const source = new EventSource(`/api/logs/${jobId}/stream`);

  source.onmessage = (e) => {
    onLog?.(JSON.parse(e.data));
  };

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
  return `/api/download/${jobId}`;
}
