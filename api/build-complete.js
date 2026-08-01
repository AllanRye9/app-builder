import { writeStatus } from './_lib/statusStore.js';

const { CALLBACK_SECRET } = process.env;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { secret, jobId, status, apkUrl, error, runUrl } = req.body || {};

  if (!CALLBACK_SECRET || secret !== CALLBACK_SECRET) {
    res.status(403).json({ error: 'Invalid callback secret.' });
    return;
  }

  if (!jobId || (status !== 'success' && status !== 'failed')) {
    res.status(400).json({ error: "jobId and status ('success' or 'failed') are required." });
    return;
  }

  await writeStatus(jobId, {
    status,
    apkUrl: apkUrl || null,
    error: error || null,
    ...(runUrl ? { runUrl } : {}),
  });

  res.status(200).json({ ok: true });
}
