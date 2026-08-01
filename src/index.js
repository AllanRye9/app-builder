import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { promises as fs } from 'fs';
import { loadConfig, toHostPath } from './config.js';
import {
  createJob,
  getJob,
  emitLog,
  emitNotice,
  emitQueuePosition,
  setStatus,
  finishJob,
  subscribe,
  deleteJob,
} from './statusStore.js';
import { checkDockerAvailable, checkImageAvailable, runAndroidBuild, killContainer } from './dockerRunner.js';
import { configure as configureQueue, schedule as scheduleBuild, removeWaiting } from './buildQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
configureQueue({ maxConcurrentBuilds: cfg.MAX_CONCURRENT_BUILDS });

const WEB_DIST_DIR = path.join(__dirname, '..', 'web', 'dist');
const APK_FILENAME = 'app.apk'; // matches build.sh's `cp "$APK_SRC" "$OUTPUT_DIR/app.apk"`

// jobId -> { projectDir, outputDir } for the lifetime of the job's data on
// disk (from upload through RETENTION_MINUTES after it finishes).
const jobDirs = new Map();
const cleanupTimers = new Map();

async function initWorkspace() {
  // Ephemeral by design (this app's own footer copy: "destroyed after each
  // job") — wipe anything left over from a previous run on boot, in case a
  // prior process was killed mid-build and its cleanup timer never fired.
  await fs.rm(cfg.JOB_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(cfg.JOB_ROOT, { recursive: true });
}
const workspaceReady = initWorkspace().catch((err) => {
  console.error('[apk-builder] Could not set up the job workspace:', err.message);
  throw err;
});

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', cfg.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  workspaceReady.then(() => next()).catch((err) =>
    res.status(503).json({ error: `Server workspace is not available: ${err.message}` })
  );
});

// --- Self-check: is Docker reachable and is the build image present? -----
app.get('/api/system-status', async (req, res) => {
  const [dockerAvailable, buildImageAvailable] = await Promise.all([
    checkDockerAvailable(cfg.DOCKER_BIN),
    checkImageAvailable(cfg.DOCKER_IMAGE, cfg.DOCKER_BIN),
  ]);
  res.json({
    ready: dockerAvailable && buildImageAvailable,
    dockerAvailable,
    buildImageAvailable,
    buildImage: cfg.DOCKER_IMAGE,
    maxConcurrentBuilds: cfg.MAX_CONCURRENT_BUILDS,
    buildTimeoutMinutes: cfg.BUILD_TIMEOUT_MINUTES,
    retentionMinutes: cfg.RETENTION_MINUTES,
  });
});

// --- Upload -----------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const jobId = req.jobId || (req.jobId = randomUUID());
      const dir = path.join(cfg.JOB_ROOT, jobId);
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
    },
    filename: (req, file, cb) => cb(null, 'upload.zip'),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      return cb(new Error('Only .zip archives are accepted.'));
    }
    cb(null, true);
  },
});

app.post('/api/upload', (req, res) => {
  upload.single('zip')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'A .zip file is required (field name "zip").' });

    const jobId = req.jobId;
    const filename = req.file.originalname;
    createJob(jobId, { filename });
    res.status(202).json({ jobId });

    // Fire-and-forget: the client picks up everything from here via the
    // SSE stream at /api/logs/:jobId/stream, not this response.
    runJob(jobId, { zipPath: req.file.path, filename }).catch((err2) => {
      console.error(`[apk-builder] job ${jobId} crashed unexpectedly:`, err2);
    });
  });
});

async function runJob(jobId, { zipPath, filename }) {
  const jobDir = path.join(cfg.JOB_ROOT, jobId);
  const projectDir = path.join(jobDir, 'project');
  const outputDir = path.join(jobDir, 'output');

  try {
    // --- Validate -------------------------------------------------------
    await fs.mkdir(projectDir, { recursive: true });
    let zip;
    try {
      zip = new AdmZip(zipPath);
      zip.extractAllTo(projectDir, true);
    } catch (err) {
      throw new ValidationError(`Could not extract the archive — is it a valid .zip? (${err.message})`);
    }

    const root = await resolveProjectRoot(projectDir);

    if (!(await exists(path.join(root, 'package.json')))) {
      throw new ValidationError('No package.json found in the uploaded project.');
    }
    for (const bad of ['android', 'ios']) {
      if (await exists(path.join(root, bad))) {
        throw new ValidationError(
          `The project already has an "${bad}" folder — remove it before uploading. This tool generates it fresh for every build.`
        );
      }
    }

    // --- Preflight: can we actually build right now? ---------------------
    const [dockerAvailable, buildImageAvailable] = await Promise.all([
      checkDockerAvailable(cfg.DOCKER_BIN),
      checkImageAvailable(cfg.DOCKER_IMAGE, cfg.DOCKER_BIN),
    ]);
    if (!dockerAvailable || !buildImageAvailable) {
      const problems = [];
      if (!dockerAvailable) problems.push("the server can't reach a Docker daemon");
      if (dockerAvailable && !buildImageAvailable) problems.push(`the build image "${cfg.DOCKER_IMAGE}" hasn't been built yet`);
      emitNotice(jobId, {
        level: 'error',
        title: 'Server not ready',
        message: `${problems.join('; ')}. See the README.`,
      });
      throw new ValidationError(`Server can't run a build right now — ${problems.join('; ')}.`);
    }

    await fs.mkdir(outputDir, { recursive: true });
    jobDirs.set(jobId, { projectDir: root, outputDir });

    // --- Queue + build ----------------------------------------------------
    let announcedQueued = false;
    await scheduleBuild(
      jobId,
      async () => {
        setStatus(jobId, 'building');
        await runAndroidBuild({
          jobId,
          dockerBin: cfg.DOCKER_BIN,
          image: cfg.DOCKER_IMAGE,
          hostProjectDir: toHostPath(root, cfg),
          hostOutputDir: toHostPath(outputDir, cfg),
          timeoutMs: cfg.BUILD_TIMEOUT_MINUTES * 60 * 1000,
          onLine: (line) => emitLog(jobId, line),
          onNotice: (notice) => emitNotice(jobId, notice),
        });
      },
      {
        onPositionChange: (position) => {
          if (!announcedQueued) {
            announcedQueued = true;
            setStatus(jobId, 'queued');
          }
          emitQueuePosition(jobId, position);
        },
      }
    );

    const apkPath = path.join(outputDir, APK_FILENAME);
    if (!(await exists(apkPath))) {
      throw new Error('The build finished but no APK was found in the output directory.');
    }
    finishJob(jobId, 'success', null, { apkFilename: APK_FILENAME });
  } catch (err) {
    removeWaiting(jobId);
    await killContainer(jobId, cfg.DOCKER_BIN);
    const message = err.message || String(err);
    if (err instanceof ValidationError) {
      emitNotice(jobId, { level: 'error', title: 'Invalid project', message });
    }
    finishJob(jobId, 'failed', message);
  } finally {
    scheduleCleanup(jobId, cfg.RETENTION_MINUTES);
  }
}

class ValidationError extends Error {}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// If the zip wraps everything in a single top-level folder (common when
// zipping a project directory rather than its contents), descend into it so
// package.json etc. are found where the rest of this expects them.
async function resolveProjectRoot(projectDir) {
  const entries = await fs.readdir(projectDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(projectDir, entries[0].name);
  }
  return projectDir;
}

function scheduleCleanup(jobId, retentionMinutes) {
  const existing = cleanupTimers.get(jobId);
  if (existing) clearTimeout(existing);
  const ms = Math.max(0, retentionMinutes) * 60 * 1000;
  const timer = setTimeout(async () => {
    cleanupTimers.delete(jobId);
    jobDirs.delete(jobId);
    deleteJob(jobId);
    try {
      await fs.rm(path.join(cfg.JOB_ROOT, jobId), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[apk-builder] Failed to clean up job ${jobId}: ${err.message}`);
    }
  }, ms);
  timer.unref?.();
  cleanupTimers.set(jobId, timer);
}

// --- Live build log/status stream (SSE) -----------------------------------
app.get('/api/logs/:jobId/stream', (req, res) => {
  const { jobId } = req.params;
  if (!getJob(jobId)) {
    return res.status(404).json({ error: 'Unknown job (it may have already been cleaned up).' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    // default "message" event needs no explicit `event:` line — matches
    // web/src/api.js's `source.onmessage` (default handler) for logs, vs.
    // `addEventListener('notice'|'status'|'queue'|'done', ...)` for the rest.
    if (event !== 'message') res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = subscribe(jobId, ({ event, data }) => send(event, data));

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// --- Download the finished APK ---------------------------------------------
app.get('/api/download/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  const dirs = jobDirs.get(req.params.jobId);
  if (!job || !dirs || job.status !== 'success' || !job.apkFilename) {
    return res.status(404).json({ error: 'No finished build found for this job (it may have failed or been cleaned up).' });
  }
  const filePath = path.join(dirs.outputDir, job.apkFilename);
  const niceName = `${job.filename.replace(/\.zip$/i, '') || 'app'}.apk`;
  res.download(filePath, niceName, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'File not found (it may have been cleaned up).' });
    }
  });
});

// --- Static frontend ---------------------------------------------------------
app.use(express.static(WEB_DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(WEB_DIST_DIR, 'index.html'));
});

const isDirectlyExecuted = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) {
  workspaceReady.then(() => {
    app.listen(cfg.PORT, () => {
      console.log(`apk-builder server listening on :${cfg.PORT}`);
    });
  });
}

export default app;
