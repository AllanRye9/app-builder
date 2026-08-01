// Load a local .env file if one exists (harmless no-op in prod/hosted
// environments where there is no .env file and env vars are injected by
// the platform instead — Render, Vercel, Railway, Fly, Docker, etc. all
// inject real process.env vars directly, so this only ever helps, never
// overrides them).
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { randomUUID, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { handleUpload } from '@vercel/blob/client';
import { initStatusStore, writeStatus, readStatus } from './statusStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Env var helpers ------------------------------------------------------
// Read (and lightly sanitize) an env var. Some dashboards let people paste
// values with surrounding quotes or trailing whitespace/newlines — trim
// those so a copy-paste mistake doesn't silently turn into "var is unset".
function env(name) {
  const v = process.env[name];
  if (v == null) return undefined;
  const trimmed = v.trim().replace(/^['"]|['"]$/g, '');
  return trimmed === '' ? undefined : trimmed;
}

// CALLBACK_SECRET only has to be known by this server and the workflow run
// it dispatches — it's handed to GitHub as part of the dispatch payload
// (see client_payload.callback_secret below), so a value generated here at
// boot works fine even if it was never set as a real env var. It just
// won't survive a restart (any in-flight job's callback would then fail),
// so setting a real CALLBACK_SECRET env var is still recommended for
// anything beyond quick local testing.
const runtimeCallbackSecret = env('CALLBACK_SECRET') ? null : randomBytes(32).toString('hex');
if (!env('CALLBACK_SECRET')) {
  console.warn(
    '[apk-builder] CALLBACK_SECRET is not set — generated a temporary one for this run. ' +
      'A build dispatched now will use this value, but if the server restarts or cold-starts ' +
      'before that build finishes (idle spin-down, redeploy, a new serverless instance), the ' +
      "value changes and the build's callbacks will get 403'd — the job will look stuck at " +
      '"queued"/"building" forever even though it actually finished on GitHub\'s side. ' +
      'Set a real CALLBACK_SECRET env var (e.g. `openssl rand -hex 32`) to avoid this.'
  );
}

// Read fresh from process.env on every call (rather than destructuring
// once at import time) so this keeps working even if env vars are
// (re)injected after the module first loads — e.g. some serverless
// cold-start paths, or env vars set via a platform API after the process
// has already started.
function getConfig() {
  return {
    GITHUB_TOKEN: env('GITHUB_TOKEN'),
    GITHUB_OWNER: env('GITHUB_OWNER'),
    GITHUB_REPO: env('GITHUB_REPO'),
    CALLBACK_SECRET: env('CALLBACK_SECRET') || runtimeCallbackSecret,
  };
}

// Whether to accept the project zip via a direct browser → Vercel Blob
// upload instead of a plain multipart POST to this server. Needed on
// Vercel specifically: Functions cap request bodies at 4.5MB, far below
// the size of most real project zips, and there is no way to raise that
// limit — the only fix is to have the browser upload straight to Blob
// storage and hand this server just the resulting URL. On platforms
// without that cap (Render, Railway, Fly, plain Docker), the original
// multipart-to-disk path works fine and needs no Blob store at all — this
// only turns on if BLOB_READ_WRITE_TOKEN is actually present.
function isBlobEnabled() {
  return Boolean(env('BLOB_READ_WRITE_TOKEN'));
}

// On Render, attach a persistent Disk and set DATA_DIR to its mount path
// (e.g. /data) so uploaded zips, built APKs, and job status all survive
// redeploys. On platforms with a read-only filesystem (e.g. Vercel, where
// only /tmp is writable, and even that doesn't persist between
// invocations), fall back to the OS temp dir instead of crashing at boot.
const DATA_DIR_CANDIDATES = [
  env('DATA_DIR'),
  path.join(__dirname, '..', 'data'),
  path.join(os.tmpdir(), 'apk-builder-data'),
].filter(Boolean);

async function resolveDataDir() {
  for (const candidate of DATA_DIR_CANDIDATES) {
    try {
      await fs.mkdir(candidate, { recursive: true });
      // Confirm it's actually writable, not just creatable.
      await fs.access(candidate, fs.constants.W_OK);
      return candidate;
    } catch (err) {
      console.warn(`[apk-builder] DATA_DIR candidate "${candidate}" isn't usable (${err.code || err.message}), trying the next fallback.`);
    }
  }
  throw new Error('No writable directory found for DATA_DIR (tried: ' + DATA_DIR_CANDIDATES.join(', ') + ')');
}

const DIST_DIR = path.join(__dirname, '..', 'dist');

const app = express();
// Render, Vercel, Railway, Fly, etc. all sit behind a reverse proxy —
// without this, req.protocol reports 'http' even for real https requests
// (Express only trusts X-Forwarded-Proto/X-Forwarded-Host when told to),
// which corrupts the callbackBase/zipUrl URLs handed to the GitHub Actions
// runner below and can cause its callbacks back to this server to silently
// fail, leaving jobs stuck at "queued"/"building" forever.
app.set('trust proxy', true);
app.use(express.json());

// These are filled in once resolveDataDir() finishes, kicked off just
// below. Routes read them lazily (at request time, not at route-definition
// time) so route registration doesn't have to wait on that async
// resolution.
let UPLOADS_DIR = null;
let APKS_DIR = null;
let dataDirError = null;

// Storage is resolved once here and never blocks the server from booting:
// if no writable directory can be found at all (rare — even the OS temp
// dir failing usually means something is very wrong with the host), the
// server still starts and serves the frontend + /api/config so the UI can
// explain what's wrong, instead of crash-looping.
async function initStorage() {
  try {
    const dataDir = await resolveDataDir();
    await initStatusStore(dataDir);
    UPLOADS_DIR = path.join(dataDir, 'uploads');
    APKS_DIR = path.join(dataDir, 'apks');
    await Promise.all([
      fs.mkdir(UPLOADS_DIR, { recursive: true }),
      fs.mkdir(APKS_DIR, { recursive: true }),
    ]);
    if (dataDir !== env('DATA_DIR') && dataDir.startsWith(os.tmpdir())) {
      console.warn(
        `[apk-builder] Using a temporary storage directory (${dataDir}) — uploads, APKs, and job ` +
          'status will NOT persist across restarts/redeploys. Set DATA_DIR to a persistent, ' +
          'writable path (e.g. a Render Disk mount) for production use.'
      );
    }
  } catch (err) {
    dataDirError = err.message;
    console.error('[apk-builder] Could not set up a storage directory — uploads will fail until this is fixed:', err.message);
  }
}

const storageReady = initStorage();

// Make sure storage init has finished (or failed cleanly, leaving
// dataDirError set) before any route handler runs. Cheap no-op on every
// request after the first, since the promise is already settled by then.
app.use((req, res, next) => {
  storageReady.then(() => next()).catch(next);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!UPLOADS_DIR) return cb(new Error('Storage directory is not available yet.'));
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
  const { CALLBACK_SECRET } = getConfig();
  const secret = req.body?.secret;
  if (!CALLBACK_SECRET || secret !== CALLBACK_SECRET) {
    return res.status(403).json({ error: 'Invalid callback secret.' });
  }
  next();
}

// --- Report which required env vars are missing, for the frontend to show
// a clear banner instead of people only finding out on their first upload.
app.get('/api/config', (req, res) => {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, CALLBACK_SECRET } = getConfig();
  const missing = [];
  if (!GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!GITHUB_OWNER) missing.push('GITHUB_OWNER');
  if (!GITHUB_REPO) missing.push('GITHUB_REPO');
  if (!CALLBACK_SECRET) missing.push('CALLBACK_SECRET');
  const blobEnabled = isBlobEnabled();
  res.status(200).json({
    ready: missing.length === 0 && !dataDirError,
    missingEnvVars: missing,
    // 'blob' mode uploads the zip straight from the browser to Vercel Blob
    // (see isBlobEnabled() above); 'disk' mode posts it to this server's
    // own /uploads directory. The frontend uses this to pick which upload
    // path to take — see src/api.js.
    storageMode: blobEnabled ? 'blob' : 'disk',
    storageAvailable: blobEnabled ? true : Boolean(UPLOADS_DIR && APKS_DIR),
    storageError: blobEnabled ? null : dataDirError,
    // True when CALLBACK_SECRET was never actually set and this server is
    // relying on the auto-generated fallback — builds still work, but if
    // this process restarts/cold-starts mid-build, the secret changes and
    // that build's callbacks will 403, leaving it stuck at
    // "queued"/"building" forever. Set a real CALLBACK_SECRET to avoid it.
    usingTemporaryCallbackSecret: !env('CALLBACK_SECRET'),
  });
});

// --- Blob mode: issue a short-lived, scoped token so the browser can
// upload the zip directly to Vercel Blob, bypassing this Function's 4.5MB
// body limit entirely. Only the token is generated here — the file bytes
// never pass through this server. See src/api.js's uploadAndStartBuild for
// the client side of this exchange.
app.post('/api/blob-upload-token', async (req, res) => {
  if (!isBlobEnabled()) {
    return res.status(503).json({
      error: 'Blob storage is not configured on this deployment (BLOB_READ_WRITE_TOKEN is unset).',
    });
  }
  try {
    // handleUpload expects a WHATWG Request (it reads request.headers via
    // the Headers API) — Express's req is a plain Node IncomingMessage, so
    // wrap it in a real Request rather than passing req directly.
    const request = new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    const jsonResponse = await handleUpload({
      body: req.body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.toLowerCase().endsWith('.zip')) {
          throw new Error('Only .zip archives are accepted.');
        }
        return {
          allowedContentTypes: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
          addRandomSuffix: true,
          maximumSizeInBytes: 200 * 1024 * 1024,
          // v2+ of the SDK needs this spelled out explicitly for any
          // deployment that isn't using Vercel's own System Environment
          // Variables to infer it (e.g. BLOB_READ_WRITE_TOKEN set by hand
          // rather than via an attached store) — without it,
          // onUploadCompleted below silently never fires.
          callbackUrl: `${req.protocol}://${req.get('host')}/api/blob-upload-token`,
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('[apk-builder] Blob upload completed:', blob.url);
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('[apk-builder] /api/blob-upload-token failed:', err);
    res.status(400).json({ error: err.message });
  }
});

// --- Blob mode: the browser already uploaded the zip straight to Blob
// storage (via the token above) — this just records the job and dispatches
// the GitHub Actions build, same as /api/upload-and-start below but
// without ever handling the file itself.
app.post('/api/start-build', async (req, res) => {
  const { blobUrl, filename } = req.body || {};
  if (!blobUrl || !filename) {
    return res.status(400).json({ error: 'blobUrl and filename are required.' });
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(blobUrl);
  } catch {
    return res.status(400).json({ error: 'blobUrl is not a valid URL.' });
  }
  if (!parsedUrl.hostname.endsWith('.public.blob.vercel-storage.com')) {
    return res.status(400).json({ error: 'blobUrl must be a Vercel Blob public storage URL.' });
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, CALLBACK_SECRET } = getConfig();
  const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'CALLBACK_SECRET'].filter(
    (name) => !getConfig()[name]
  );
  if (missing.length > 0) {
    return res.status(500).json({
      error: `Server is missing ${missing.join(', ')} — set ${missing.length > 1 ? 'these' : 'it'} in your hosting platform's Environment/Variables settings (see README).`,
    });
  }

  const jobId = randomUUID();
  const callbackBase = `${req.protocol}://${req.get('host')}`;

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
    const message = `Could not start the GitHub Actions build (HTTP ${dispatchRes.status}). Check GITHUB_TOKEN's permissions and that the workflow file is on the repo's default branch. ${detail}`;
    await writeStatus(jobId, { status: 'failed', error: message });
    return res.status(502).json({ error: 'Failed to dispatch build workflow.', jobId, detail: message });
  }

  res.status(202).json({ jobId });
});

// --- Upload the project zip and kick off the GitHub Actions build ---------
app.post('/api/upload-and-start', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'A .zip file is required.' });

    const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, CALLBACK_SECRET } = getConfig();
    const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'CALLBACK_SECRET'].filter(
      (name) => !getConfig()[name]
    );
    if (missing.length > 0) {
      return res.status(500).json({
        error: `Server is missing ${missing.join(', ')} — set ${missing.length > 1 ? 'these' : 'it'} in your hosting platform's Environment/Variables settings (see README).`,
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
      const message = `Could not start the GitHub Actions build (HTTP ${dispatchRes.status}). Check GITHUB_TOKEN's permissions and that the workflow file is on the repo's default branch. ${detail}`;
      await writeStatus(jobId, { status: 'failed', error: message });
      return res.status(502).json({ error: 'Failed to dispatch build workflow.', jobId, detail: message });
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
      if (!APKS_DIR) return cb(new Error('Storage directory is not available yet.'));
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
    const { CALLBACK_SECRET } = getConfig();
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

// --- Static files ---------------------------------------------------------
// UPLOADS_DIR/APKS_DIR aren't known until resolveDataDir() finishes (below),
// so these wrap express.static in a small dispatcher that looks the
// directory up at request time instead of route-registration time.
function staticFrom(getDir) {
  const middlewareCache = new Map();
  return (req, res, next) => {
    const dir = getDir();
    if (!dir) return res.status(503).json({ error: 'Storage is not available on this deployment yet.' });
    let mw = middlewareCache.get(dir);
    if (!mw) {
      mw = express.static(dir);
      middlewareCache.set(dir, mw);
    }
    mw(req, res, next);
  };
}
app.use('/uploads', staticFrom(() => UPLOADS_DIR));
app.use('/apks', staticFrom(() => APKS_DIR));
app.use(express.static(DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/apks')) {
    return next();
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// --- Startup ---------------------------------------------------------------
// Vercel (and similar) import this module and call the exported app
// directly per-request — it must not call app.listen() itself there.
// Everywhere else (Render, Railway, Fly, plain Docker, local `npm start`)
// this is a normal long-running process, so it does.
const isServerless = Boolean(env('VERCEL') || env('AWS_LAMBDA_FUNCTION_NAME'));

if (!isServerless) {
  const port = Number(env('PORT')) || 3000;
  storageReady.then(() => {
    app.listen(port, () => {
      console.log(`apk-builder server listening on :${port}`);
    });
  });
}
// On serverless platforms, the `storageReady` gate middleware registered
// right after express.json() above already makes sure storage init has
// finished (or failed cleanly) before any route handler runs — no
// app.listen() needed there; the platform calls the exported app per-request.

export default app;
