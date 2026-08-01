import { spawn } from 'child_process';

// --- Local, ephemeral Docker build orchestration ---------------------------
//
// This replaces the previous GitHub Actions edition's repository_dispatch
// call. Instead of asking a remote runner to build the APK, this server
// shells out to the Docker CLI on its own host to run a short-lived
// container from a purpose-built image (see docker/android-build/), mounts
// the uploaded project in read-only, mounts an empty output directory in
// writable, and reads back whatever .apk file the container produced.
//
// Requirements this depends on (see README "Running the build locally with
// Docker" section):
//   - A `docker` binary on PATH that can reach a working Docker daemon.
//   - The build image already built: `docker build -t apk-builder-android
//     docker/android-build`.
//   - hostUploadDir/hostOutputDir passed in must be paths the Docker
//     *daemon* can actually see. On a bare host/VPS running this server
//     directly (recommended), that's just the same path Node sees. If this
//     server itself runs inside a container with docker.sock bind-mounted in
//     (Docker-out-of-Docker), those paths must be translated to the
//     *host's* view of the shared volume first — see toHostPath() in
//     server/index.js and the hostWorkspaceRoot config field.

export const DEFAULT_IMAGE = 'apk-builder-android:latest';
export const DEFAULT_TIMEOUT_MINUTES = 20;
const PROBE_TIMEOUT_MS = 8000;
const MAX_LOG_CHARS = 20000;

function containerName(jobId) {
  // Docker container names only allow [a-zA-Z0-9][a-zA-Z0-9_.-]* — jobId is
  // always a crypto.randomUUID() (hex + hyphens) so it's already safe, but
  // sanitize defensively since this value ends up on a command line.
  const safe = String(jobId).replace(/[^a-zA-Z0-9_.-]/g, '');
  return `apk-build-${safe}`;
}

// --- Preflight checks --------------------------------------------------
// Run before accepting an upload so a misconfigured host fails fast with a
// clear message, the same way the previous edition failed fast on a missing
// githubToken/githubOwner/githubRepo — instead of accepting the upload and
// only discovering the problem after the fact.

export function checkDockerAvailable(dockerBin = 'docker') {
  return probe(dockerBin, ['version', '--format', '{{.Server.Version}}'], (out) => out.trim().length > 0);
}

export function checkImageAvailable(image, dockerBin = 'docker') {
  return probe(dockerBin, ['image', 'inspect', image], () => true);
}

function probe(dockerBin, args, isOk) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let child;
    try {
      child = spawn(dockerBin, args);
    } catch {
      finish(false);
      return;
    }

    let out = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && isOk(out)));

    const t = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    t.unref?.();
  });
}

// --- The actual build ---------------------------------------------------
// Resolves with { logTail } on a zero exit code, rejects with an Error
// (message is safe to show the user / store as job.error) otherwise.
export function runAndroidBuild({
  jobId,
  dockerBin = 'docker',
  image = DEFAULT_IMAGE,
  hostUploadDir,
  hostOutputDir,
  zipFilename,
  timeoutMs = DEFAULT_TIMEOUT_MINUTES * 60 * 1000,
  onPhase,
  onLog,
}) {
  return new Promise((resolve, reject) => {
    const name = containerName(jobId);
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '-v',
      `${hostUploadDir}:/workspace/upload:ro`,
      '-v',
      `${hostOutputDir}:/workspace/output`,
      '-e',
      `ZIP_FILENAME=${zipFilename}`,
      image,
    ];

    let child;
    try {
      child = spawn(dockerBin, args);
    } catch (err) {
      reject(new Error(`Could not start the build container: ${err.message}`));
      return;
    }

    let settled = false;
    let logTail = '';
    let killedForTimeout = false;

    const appendLog = (chunk) => {
      const text = chunk.toString();
      onLog?.(text);
      logTail = (logTail + text).slice(-MAX_LOG_CHARS);
      for (const line of text.split('\n')) {
        const m = /^PHASE:(\S+)/.exec(line.trim());
        if (m) onPhase?.(m[1]);
      }
    };
    child.stdout?.on('data', appendLog);
    child.stderr?.on('data', appendLog);

    const timer = setTimeout(() => {
      killedForTimeout = true;
      spawn(dockerBin, ['kill', name]).on('error', () => {});
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start the build container: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killedForTimeout) {
        reject(new Error(`Build timed out after ${Math.round(timeoutMs / 60000)} minute(s) and was stopped.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Build failed (exit code ${code}).\n${tail(logTail, 15)}`));
        return;
      }
      resolve({ logTail });
    });
  });
}

function tail(text, lines) {
  return text.trim().split('\n').slice(-lines).join('\n');
}

// Best-effort cleanup for a container that may have been `docker kill`ed
// (which stops it but --rm's removal races with that) or left behind after
// an unexpected server crash mid-build.
export function killContainer(jobId, dockerBin = 'docker') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(dockerBin, ['rm', '-f', containerName(jobId)]);
    } catch {
      resolve();
      return;
    }
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}
