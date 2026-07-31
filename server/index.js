import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { promises as fs } from 'fs';
import { initStatusStore, writeStatus, readStatus } from './statusStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, CALLBACK_SECRET, PORT } = process.env;

// On Render, attach a persistent Disk and set DATA_DIR to its mount path
// (e.g. /data) so uploaded zips, built APKs, and job status all survive
// redeploys. Without a disk this still works — DATA_DIR just falls back to
// local container storage, which is wiped on every deploy/restart.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const APKS_DIR = path.join(DATA_DIR, 'apks');
const DIST_DIR = path.join(__dirname, '..', 'dist');

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId || (req.jobId = randomUUID());
      const dir = path.join(UPLOADS_DIR, jobId);
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — a real server process, so no 4.5MB function-body cap
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      return cb(new Error('Only .zip archives are accepted.'));
    }
    cb(null, true);
  },
});

function requireCallbackSecret(req, res, next) {
  const secret = req.body?.secret;
  if (!CALLBACK_SECRET || secret !== CALLBACK_SECRET) {
    return res.status(403).json({ error: 'Invalid callback secret.' });
  }
  next();
}

// --- Upload the project zip and kick off the GitHub Actions build ---------
app.post('/api/upload-and-start', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'A .zip file is required.' });

    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !CALLBACK_SECRET) {
      return res.status(500).json({
        error: 'Server is missing GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, or CALLBACK_SECRET — set these in the Render service\'s Environment settings (see README).',
      });
    }

    const jobId = req.jobId;
    const filename = req.file.originalname;
    const callbackBase = `${req.protocol}://${req.get('host')}`;
    const zipUrl = `${callbackBase}/uploads/${jobId}/${encodeURIComponent(filename)}`;

    await writeStatus(jobId, { status: 'queued', filename, error: null, apkUrl: null, runUrl: null });

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
            zip_url: zipUrl,
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
      return res.status(502).json({ error: 'Failed to dispatch build workflow.', jobId });
    }

    res.status(202).json({ jobId });
  });
});

// --- Poll job status --------------------------------------------------
app.get('/api/status', async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId query param is required.' });

  const status = await readStatus(jobId);
  if (!status) return res.status(404).json({ error: 'Unknown job.' });

  res.set('Cache-Control', 'no-store');
  res.status(200).json(status);
});

// --- Called by the GitHub Actions runner as the build progresses ------
app.post('/api/build-progress', requireCallbackSecret, async (req, res) => {
  const { jobId, status, runUrl } = req.body || {};
  if (!jobId || !status) return res.status(400).json({ error: 'jobId and status are required.' });

  await writeStatus(jobId, { status, ...(runUrl ? { runUrl } : {}) });
  res.status(200).json({ ok: true });
});

// --- Called by the GitHub Actions runner with the final result --------
app.post('/api/build-complete', requireCallbackSecret, async (req, res) => {
  const { jobId, status, apkUrl, error, runUrl } = req.body || {};
  if (!jobId || (status !== 'success' && status !== 'failed')) {
    return res.status(400).json({ error: "jobId and status ('success' or 'failed') are required." });
  }

  await writeStatus(jobId, {
    status,
    apkUrl: apkUrl || null,
    error: error || null,
    ...(runUrl ? { runUrl } : {}),
  });
  res.status(200).json({ ok: true });
});

// --- Called by the GitHub Actions runner to hand back the built APK ---
const apkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(APKS_DIR, req.body.jobId || 'unknown');
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

app.post('/api/upload-apk', (req, res) => {
  apkUpload.single('apk')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (req.body.secret !== CALLBACK_SECRET) {
      return res.status(403).json({ error: 'Invalid callback secret.' });
    }
    if (!req.file || !req.body.jobId) {
      return res.status(400).json({ error: 'jobId and an apk file are required.' });
    }
    const callbackBase = `${req.protocol}://${req.get('host')}`;
    const url = `${callbackBase}/apks/${req.body.jobId}/${encodeURIComponent(req.file.originalname)}`;
    res.status(200).json({ url });
  });
});

// --- Static files -------------------------------------------------------
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/apks', express.static(APKS_DIR));
app.use(express.static(DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/apks')) {
    return next();
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const port = PORT || 3000;
initStatusStore(DATA_DIR)
  .then(() => Promise.all([
    fs.mkdir(UPLOADS_DIR, { recursive: true }),
    fs.mkdir(APKS_DIR, { recursive: true }),
  ]))
  .then(() => {
    app.listen(port, () => {
      console.log(`apk-builder server listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
