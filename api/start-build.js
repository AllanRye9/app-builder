import { randomUUID } from 'crypto';
import { writeStatus } from './_lib/statusStore.js';

const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, CALLBACK_SECRET } = process.env;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !CALLBACK_SECRET) {
    res.status(500).json({
      error: 'Server is missing GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, or CALLBACK_SECRET — set these in Vercel project settings (see README).',
    });
    return;
  }

  const { blobUrl, filename } = req.body || {};
  if (!blobUrl || !filename) {
    res.status(400).json({ error: 'blobUrl and filename are required.' });
    return;
  }

  const jobId = randomUUID();
  const callbackBase = `https://${req.headers.host}`;

  await writeStatus(jobId, { status: 'queued', filename, error: null, apkUrl: null, runUrl: null });

  // repository_dispatch (not workflow_dispatch) so the payload isn't capped
  // at workflow_dispatch's 64KB input limit, and so multiple concurrent
  // builds can't collide on GitHub's one-dispatch-per-ref-per-workflow
  // restriction. The workflow file listens for event_type "build-apk".
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'build-apk',
        client_payload: {
          job_id: jobId,
          zip_url: blobUrl,
          filename,
          callback_base: callbackBase,
          callback_secret: CALLBACK_SECRET,
        },
      }),
    }
  );

  if (!dispatchRes.ok) {
    const detail = await dispatchRes.text().catch(() => '');
    await writeStatus(jobId, {
      status: 'failed',
      error: `Could not start the GitHub Actions build (HTTP ${dispatchRes.status}). Check GITHUB_TOKEN's permissions and that the workflow file is on the repo's default branch. ${detail}`,
    });
    res.status(502).json({ error: 'Failed to dispatch build workflow.', jobId });
    return;
  }

  res.status(202).json({ jobId });
}
