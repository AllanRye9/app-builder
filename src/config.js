'use strict';

const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// JOB_ROOT vs HOST_JOB_ROOT
// ---------------------------------------------------------------------------
// JOB_ROOT is the path *this process* uses to read/write job files. When the
// server itself runs inside a container, this is a path inside that
// container (e.g. /workspace/jobs).
//
// HOST_JOB_ROOT is the path to that *same directory on the Docker host*.
// This server builds APKs by shelling out to `docker run`, which talks to
// the host's Docker daemon (either directly, or via a mounted
// /var/run/docker.sock when the server itself is containerized — a pattern
// called Docker-outside-of-Docker / DooD). The daemon always resolves bind
// mounts against the *host* filesystem, never against the caller's
// filesystem. So if this server is itself inside a container, JOB_ROOT and
// HOST_JOB_ROOT are two different paths that happen to point at the same
// bind-mounted directory:
//
//   host:      $(pwd)/.jobs/<id>/project
//   container: /workspace/jobs/<id>/project      (same directory, bind-mounted)
//
// Passing the container path to `docker run -v ...` would tell the host
// daemon to mount a path that doesn't exist on the host — which is exactly
// what produces errors like "cd: /project: No such file or directory"
// inside the child build container: the bind mount silently resolves to an
// empty/nonexistent directory instead of the extracted project.
//
// docker-compose.yml sets HOST_JOB_ROOT to the real host path. When running
// the server directly on the host (no container), leave HOST_JOB_ROOT unset
// and it simply defaults to JOB_ROOT, since there's no path translation to do.
const JOB_ROOT = process.env.JOB_ROOT || path.join(os.tmpdir(), 'apk-builder-jobs');
const HOST_JOB_ROOT = process.env.HOST_JOB_ROOT || JOB_ROOT;

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DOCKER_IMAGE: process.env.DOCKER_IMAGE || 'apk-builder-android:latest',
  MAX_CONCURRENT_BUILDS: parseInt(process.env.MAX_CONCURRENT_BUILDS || '1', 10),
  BUILD_MEMORY_LIMIT: process.env.BUILD_MEMORY_LIMIT || '2g',
  BUILD_CPU_LIMIT: process.env.BUILD_CPU_LIMIT || '2',
  BUILD_TIMEOUT_MS: parseInt(process.env.BUILD_TIMEOUT_MS || `${15 * 60 * 1000}`, 10),
  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES || `${150 * 1024 * 1024}`, 10),
  JOB_ROOT,
  HOST_JOB_ROOT,
  JOB_TTL_MS: parseInt(process.env.JOB_TTL_MS || `${60 * 60 * 1000}`, 10),
  // Which origin(s) may call this API from a browser. '*' (default) allows
  // any origin — fine for a worker with no auth/cookies to leak. Set to a
  // comma-separated list (e.g. "https://your-app.vercel.app") to lock it
  // down once the frontend is deployed separately (see web/src/api.js and
  // the root README's frontend/worker split section).
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
};
