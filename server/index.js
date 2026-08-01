import express from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { writeStatus, readStatus, deleteStatus } from './statusStore.js';
import { loadConfig } from './config.js';
import {
  checkDockerAvailable,
  checkImageAvailable,
  runAndroidBuild,
  killContainer,
  DEFAULT_IMAGE,
  DEFAULT_TIMEOUT_MINUTES,
} from './dockerBuild.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config file helper -----------------------------------------------
// Trim stray whitespace/quotes so a copy-paste mistake into config.json
// doesn't silently turn into "field is unset".
function field(raw) {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim().replace(/^['"]|['"]$/g, '');
  return trimmed === '' ? undefined : trimmed;
}

// Read fresh from config.json on every call (rather than caching once at
// import time) so editing the file takes effect immediately, without
// restarting the process — same reasoning as server/config.js.
function getConfig() {
  const cfg = loadConfig();
  return {
    DOCKER_BIN: field(cfg.dockerBin) || 'docker',
    BUILD_IMAGE: field(cfg.buildImage) || DEFAULT_IMAGE,
    BUILD_TIMEOUT_MINUTES: Number(field(cfg.buildTimeoutMinutes)) || DEFAULT_TIMEOUT_MINUTES,
    RETENTION_MINUTES: Number(field(cfg.retentionMinutes)) || 5,
    HOST_WORKSPACE_ROOT: field(cfg.hostWorkspaceRoot) || null,
    PORT: Number(field(cfg.port)) || undefined,
    _configSource: cfg._source,
  };
}

// --- Ephemeral per-job workspace ---------------------------------------
// Unlike the previous GitHub Actions edition, there is no persistent
// dataDir anymore. Every upload gets its own directory under JOBS_ROOT
// (upload/ for the project zip, output/ for whatever the build container
// produces), and that whole directory is deleted automatically
// RETENTION_MINUTES after the job finishes — see scheduleCleanup() below.
// JOBS_ROOT itself is resolved once at boot (like the old DATA_DIR was),
// not re-read per request, since changing it mid-run would orphan
// in-flight job directories.
const configuredWorkspaceRoot = field(loadConfig().workspaceRoot);
const JOBS_ROOT = configuredWorkspaceRoot
  ? path.resolve(configuredWorkspaceRoot)
  : path.join(os.tmpdir(), 'apk-builder-jobs');

// Only needed for the Docker-out-of-Docker deployment shape (this server
// itself runs in a container with docker.sock bind-mounted in) — see
// config.example.json's hostWorkspaceRoot comment. Translates a path this
// process sees (under JOBS_ROOT) into the equivalent path the HOST's
// Docker daemon needs for `docker run -v`. A no-op when this server runs
// directly on the same host as the Docker daemon (the recommended setup).
function toHostPath(localPath) {
  const { HOST_WORKSPACE_ROOT } = getConfig();
  if (!HOST_WORKSPACE_ROOT) return localPath;
  const rel = path.relative(JOBS_ROOT, localPath);
  return path.posix.join(HOST_WORKSPACE_ROOT.replace(/\/+$/, ''), rel.split(path.sep).join('/'));
}

// jobId -> { uploadDir, outputDir } for the lifetime of the job's data on
// disk (from upload through RETENTION_MINUTES after it finishes).
const jobDirs = new Map();
// jobId -> the pending cleanup setTimeout handle, so a job's own dirs
// aren't double-scheduled for deletion.
const cleanupTimers = new Map();

async function initWorkspace() {
  // Ephemeral by design: on boot, wipe out anything left over from a
  // previous run (e.g. the process crashed mid-build and its 5-minute
  // cleanup timer never fired) so no stale uploaded project or generated
  // APK lingers on disk longer than intended.
  await fs.rm(JOBS_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(JOBS_ROOT, { recursive: true });
}

const workspaceReady = initWorkspace().catch((err) => {
  console.error('[apk-builder] Could not set up the ephemeral job workspace:', err.message);
  throw err;
});

const DIST_DIR = path.join(__dirname, '..', 'dist');

const app = express();
app.use(express.json());

// Make sure workspace init has finished before any route handler runs.
// Cheap no-op on every request after the first, since the promise is
// already settled by then.
app.use((req, res, next) => {
  workspaceReady.then(() => next()).catch((err) =>
    res.status(503).json({ error: `Server workspace is not available: ${err.message}` })
  );
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId || (req.jobId = randomUUID());
      const dir = path.join(JOBS_ROOT, jobId, 'upload');
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — a real server process, no serverless body cap
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      return cb(new Error('Only .zip archives are accepted.'));
    }
    cb(null, true);
  },
});

// --- Report whether this host can actually run builds, for the frontend
// to show a clear banner instead of people only finding out on their first
// upload. Docker/image checks are real probes (spawn docker), not just a
// config-file read, since "docker is on PATH and the image was built" is
// exactly the thing most likely to be unset up on a fresh host.
app.get('/api/config', async (req, res) => {
  const { DOCKER_BIN, BUILD_IMAGE, BUILD_TIMEOUT_MINUTES, RETENTION_MINUTES, _configSource } = getConfig();
  const [dockerAvailable, buildImageAvailable] = await Promise.all([
    checkDockerAvailable(DOCKER_BIN),
    checkImageAvailable(BUILD_IMAGE, DOCKER_BIN),
  ]);
  res.status(200).json({
    ready: dockerAvailable && buildImageAvailable,
    dockerAvailable,
    buildImageAvailable,
    buildImage: BUILD_IMAGE,
    buildTimeoutMinutes: BUILD_TIMEOUT_MINUTES,
    retentionMinutes: RETENTION_MINUTES,
    configSource: _configSource,
  });
});

// --- Upload the project zip and kick off a local, ephemeral Docker build --
app.post('/api/upload-and-start', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'A .zip file is required.' });

    const jobId = req.jobId;
    const filename = req.file.originalname;
    const uploadDir = path.dirname(req.file.path);
    const { DOCKER_BIN, BUILD_IMAGE } = getConfig();

    // Fail fast with a clear message, same spirit as the previous edition
    // failing fast on a missing githubToken/githubOwner/githubRepo —
    // instead of accepting the upload and only discovering the problem
    // later via a stuck "building" status.
    const [dockerAvailable, buildImageAvailable] = await Promise.all([
      checkDockerAvailable(DOCKER_BIN),
      checkImageAvailable(BUILD_IMAGE, DOCKER_BIN),
    ]);
    if (!dockerAvailable || !buildImageAvailable) {
      await fs.rm(path.join(JOBS_ROOT, jobId), { recursive: true, force: true }).catch(() => {});
      const problems = [];
      if (!dockerAvailable) problems.push(`the "${DOCKER_BIN}" command isn't reaching a Docker daemon`);
      if (!buildImageAvailable) problems.push(`the build image "${BUILD_IMAGE}" hasn't been built yet (docker build -t ${BUILD_IMAGE} docker/android-build)`);
      return res.status(500).json({ error: `Server can't run a build right now — ${problems.join(' and ')}. See the README.` });
    }

    const outputDir = path.join(JOBS_ROOT, jobId, 'output');
    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch (mkdirErr) {
      return res.status(500).json({ error: `Could not prepare a build workspace: ${mkdirErr.message}` });
    }

    jobDirs.set(jobId, { uploadDir, outputDir });
    await writeStatus(jobId, { status: 'queued', filename, error: null, apkUrl: null });
    res.status(202).json({ jobId });

    // Fire-and-forget: the client picks up progress via /api/status
    // polling, not by holding this request open.
    runJob(jobId, { uploadDir, outputDir, filename }).catch((err) => {
      console.error(`[apk-builder] job ${jobId} crashed unexpectedly:`, err);
    });
  });
});

async function runJob(jobId, { uploadDir, outputDir, filename }) {
  const { DOCKER_BIN, BUILD_IMAGE, BUILD_TIMEOUT_MINUTES, RETENTION_MINUTES } = getConfig();
  await writeStatus(jobId, { status: 'building' });

  try {
    await runAndroidBuild({
      jobId,
      dockerBin: DOCKER_BIN,
      image: BUILD_IMAGE,
      hostUploadDir: toHostPath(uploadDir),
      hostOutputDir: toHostPath(outputDir),
      zipFilename: filename,
      timeoutMs: BUILD_TIMEOUT_MINUTES * 60 * 1000,
    });

    const apkFilename = await findApk(outputDir);
    if (!apkFilename) {
      throw new Error('The build finished but no .apk file was found in the output directory.');
    }
    await writeStatus(jobId, {
      status: 'success',
      apkUrl: `/apks/${jobId}/${encodeURIComponent(apkFilename)}`,
      error: null,
    });
  } catch (err) {
    await writeStatus(jobId, { status: 'failed', error: err.message });
    await killContainer(jobId, DOCKER_BIN);
  } finally {
    scheduleCleanup(jobId, RETENTION_MINUTES);
  }
}

async function findApk(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return null;
  }
  return entries.find((name) => name.toLowerCase().endsWith('.apk')) || null;
}

// Deletes an ephemeral job's upload/output/status RETENTION_MINUTES after
// it reaches a terminal state — this is the "destroyed after 5 minutes"
// behavior. A build that never reaches a terminal state (e.g. this process
// is killed mid-build) is instead cleaned up by initWorkspace() wiping
// JOBS_ROOT on the next boot.
function scheduleCleanup(jobId, retentionMinutes) {
  const existing = cleanupTimers.get(jobId);
  if (existing) clearTimeout(existing);

  const ms = Math.max(0, retentionMinutes) * 60 * 1000;
  const timer = setTimeout(async () => {
    cleanupTimers.delete(jobId);
    jobDirs.delete(jobId);
    await deleteStatus(jobId);
    try {
      await fs.rm(path.join(JOBS_ROOT, jobId), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[apk-builder] Failed to clean up job ${jobId}: ${err.message}`);
    }
  }, ms);
  timer.unref?.();
  cleanupTimers.set(jobId, timer);
}

// --- Poll job status --------------------------------------------------
app.get('/api/status', async (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId query param is required.' });

  const status = await readStatus(jobId);
  if (!status) return res.status(404).json({ error: 'Unknown job (it may have already been cleaned up).' });

  res.set('Cache-Control', 'no-store');
  res.status(200).json(status);
});

// --- Serve a finished build's APK ---------------------------------------
// No global static directory anymore (each job is isolated under its own
// ephemeral dir), so this looks the job's output dir up at request time and
// stops working once that job's retention window has passed.
app.get('/apks/:jobId/:filename', (req, res) => {
  const dirs = jobDirs.get(req.params.jobId);
  if (!dirs) {
    return res.status(404).json({ error: "This build's files have been cleaned up, or the job id is unknown." });
  }
  const filePath = path.join(dirs.outputDir, req.params.filename);
  if (filePath !== dirs.outputDir && !filePath.startsWith(dirs.outputDir + path.sep)) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'File not found (it may have been cleaned up).' });
    }
  });
});

// --- Static files ---------------------------------------------------------
app.use(express.static(DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/apks')) {
    return next();
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// --- Startup ---------------------------------------------------------------
// Vercel (and similar) import this module and call the exported app
// directly per-request — it must not call app.listen() itself there. Note,
// though: Vercel Functions have no way to reach a Docker daemon at all, so
// builds can never actually succeed there under this architecture — see
// README.
const isDirectlyExecuted = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectlyExecuted) {
  const port = getConfig().PORT || 3000;
  workspaceReady.then(() => {
    app.listen(port, () => {
      console.log(`apk-builder server listening on :${port}`);
    });
  });
}

export default app;
