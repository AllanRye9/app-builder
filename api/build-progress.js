import { writeStatus } from './_lib/statusStore.js';

const { CALLBACK_SECRET } = process.env;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { secret, jobId, status, runUrl } = req.body || {};

  // Without this, anyone who found this URL could flip any job's status —
  // this is the one thing standing between "a webhook only the workflow
  // knows how to call" and "a public write endpoint." The secret travels
  // with the dispatch payload (see start-build.js) and back out as a
  // GitHub Actions secret the workflow reads at run time.
  if (!CALLBACK_SECRET || secret !== CALLBACK_SECRET) {
    res.status(403).json({ error: 'Invalid callback secret.' });
    return;
  }

  if (!jobId || !status) {
    res.status(400).json({ error: 'jobId and status are required.' });
    return;
  }

  await writeStatus(jobId, { status, ...(runUrl ? { runUrl } : {}) });
  res.status(200).json({ ok: true });
}
