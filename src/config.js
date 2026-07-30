'use strict';

const path = require('path');
const os = require('os');

// No Docker-outside-of-Docker path translation needed here (unlike the
// original VPS/docker-compose version) — builds now run as direct
// subprocesses inside this same container (see buildRunner.js), so there's
// only ever one filesystem in play.
const JOB_ROOT = process.env.JOB_ROOT || path.join(os.tmpdir(), 'apk-builder-jobs');

module.exports = {
  // Most platforms inject PORT themselves — the app must listen on
  // whatever it sets. Falls back to 3000 for local/bare `docker run` use.
  PORT: parseInt(process.env.PORT || '3000', 10),

  // Builds now share this one container's CPU/RAM directly (no per-job
  // Docker --memory/--cpus cap possible anymore, since there's no sibling
  // container to cap). Default is deliberately conservative — Gradle + the
  // Android Gradle Plugin alone can use 1.5-2.5GB per concurrent build, on
  // top of whatever the Express server itself needs. Size this against your
  // host/plan's actual RAM, not against how many CPU cores it has.
  MAX_CONCURRENT_BUILDS: parseInt(process.env.MAX_CONCURRENT_BUILDS || '2', 10),

  BUILD_TIMEOUT_MS: parseInt(process.env.BUILD_TIMEOUT_MS || `${15 * 60 * 1000}`, 10),
  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES || `${300 * 1024 * 1024}`, 10),
  JOB_ROOT,
  JOB_TTL_MS: parseInt(process.env.JOB_TTL_MS || `${60 * 60 * 1000}`, 10),

  // Frontend and API are served from this same service by default,
  // so cross-origin requests aren't the normal case here — but kept
  // available in case you ever split the frontend out separately.
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',

  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || `${10 * 60 * 1000}`, 10),
};
