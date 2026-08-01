import os from 'os';
import path from 'path';

// Config comes from environment variables here — NOT config.json — because
// that's the convention docker-compose.yml already established (PORT,
// DOCKER_IMAGE, JOB_ROOT, HOST_JOB_ROOT, CORS_ORIGIN are all set under
// services.app.environment there). MAX_CONCURRENT_BUILDS,
// BUILD_TIMEOUT_MINUTES, and RETENTION_MINUTES aren't set in
// docker-compose.yml (nothing required them to be) but are read the same
// way, with defaults, so they're overridable without editing that file.
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig() {
  const PORT = num(process.env.PORT, 3000);
  const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'apk-builder-android:latest';

  // JOB_ROOT is where this process itself sees per-job directories
  // (docker-compose.yml sets it to /workspace/jobs, bind-mounted from the
  // host's ./.jobs). Running `node src/index.js` directly on a host with no
  // Docker Compose involved, JOB_ROOT falls back to a plain OS temp dir.
  const JOB_ROOT = process.env.JOB_ROOT
    ? path.resolve(process.env.JOB_ROOT)
    : path.join(os.tmpdir(), 'apk-builder-jobs');

  // HOST_JOB_ROOT is JOB_ROOT's path as seen by the HOST's Docker daemon —
  // required because this server talks to that daemon over a bind-mounted
  // /var/run/docker.sock (Docker-outside-of-Docker: see docker-compose.yml's
  // top comment and docker/android-build/build.sh's "cd: /project: No such
  // file or directory" note). `docker run -v <path>...` issued from inside
  // this container is actually executed by the host daemon, which can't see
  // paths that only exist inside this container's own filesystem — so those
  // paths must be translated to HOST_JOB_ROOT's equivalent before being
  // passed to `docker run`. Left unset, no translation is applied (correct
  // when this process runs directly on the same host as the Docker daemon,
  // e.g. no Docker Compose / DooD involved at all).
  const HOST_JOB_ROOT = process.env.HOST_JOB_ROOT
    ? process.env.HOST_JOB_ROOT.replace(/\/+$/, '')
    : null;

  const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
  const MAX_CONCURRENT_BUILDS = num(process.env.MAX_CONCURRENT_BUILDS, 2);
  const BUILD_TIMEOUT_MINUTES = num(process.env.BUILD_TIMEOUT_MINUTES, 20);

  // How long a finished job's project/output directory (and its status/log
  // history) is kept before being deleted automatically. Builds run in
  // disposable containers already (see the app's own footer copy); this
  // extends the same "nothing lingers" principle to what's on disk between
  // the container exiting and someone downloading the APK.
  const RETENTION_MINUTES = num(process.env.RETENTION_MINUTES, 5);

  const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';

  return {
    PORT,
    DOCKER_IMAGE,
    JOB_ROOT,
    HOST_JOB_ROOT,
    CORS_ORIGIN,
    MAX_CONCURRENT_BUILDS,
    BUILD_TIMEOUT_MINUTES,
    RETENTION_MINUTES,
    DOCKER_BIN,
  };
}

// Translates a path this process sees (must be under JOB_ROOT) into the
// equivalent path the HOST's Docker daemon needs for `docker run -v`.
export function toHostPath(localPath, { JOB_ROOT, HOST_JOB_ROOT }) {
  if (!HOST_JOB_ROOT) return localPath;
  const rel = path.relative(JOB_ROOT, localPath);
  return path.posix.join(HOST_JOB_ROOT, rel.split(path.sep).join('/'));
}
