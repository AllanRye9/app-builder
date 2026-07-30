import { readStatus } from './_lib/statusStore.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    res.status(400).json({ error: 'jobId query param is required.' });
    return;
  }

  const status = await readStatus(jobId);
  if (!status) {
    res.status(404).json({ error: 'Unknown job.' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(status);
}
