'use strict';

const path = require('path');
const os = require('os');

// No Docker-outside-of-Docker path translation needed here (unlike the
// original VPS/docker-compose version) — builds now run as direct
// subprocesses inside this same container (see buildRunner.js), so there's
// only ever one filesystem in play.
const JOB_ROOT = process.env.JOB_ROOT || path.join(os.tmpdir(), 'apk-builder-jobs');

// Deliberately OUTSIDE JOB_ROOT (which per-job dirs live under and get
// wiped by purgeJob/the TTL sweep) — these are shared across every job for
// as long as the container lives, which is the entire point: without them,
// every single build re-downloads the full Gradle distribution + every
// Maven/npm dependency from scratch, even though back-to-back builds in the
// same container almost always want the exact same handful of packages
// (Capacitor core/cli/android, AndroidX, Kotlin stdlib, ...). Reusing that
// cache is the single biggest lever on build time available here — it costs
// disk, not correctness, since both npm and Gradle key their caches by
// package name+version+hash already.
const NPM_CACHE_DIR = process.env.NPM_CACHE_DIR || path.join(os.tmpdir(), 'apk-builder-cache', 'npm');

// NOTE: this is intentionally NOT used as GRADLE_USER_HOME anymore. Gradle
// keeps its daemon registry (daemon/<version>/registry.bin + the port files
// daemons advertise themselves on) *inside* GRADLE_USER_HOME. Pointing every
// concurrent build at the same GRADLE_USER_HOME means their single-use
// daemons share that registry — one build's client can end up handed the
// address of a DIFFERENT build's daemon, whose handshake it can't parse.
// That's the "Unexpected type tag N found" / endless "Unable to receive
// command from client socket connection ... Discarding connection" loop:
// not a build failure, a protocol collision, and it never resolves on its
// own — it loops until BUILD_TIMEOUT_MS kills the job.
//
// Fix: split the two concerns Gradle bundles into GRADLE_USER_HOME.
//  - GRADLE_RO_DEP_CACHE (this dir): shared, persistent, read-only reuse of
//    downloaded module/artifact caches + wrapper distributions across every
//    job — this is where the real time savings live, and it's safe to
//    share because Gradle only reads it here (see runGradle in
//    buildRunner.js).
//  - GRADLE_USER_HOME: set per-job in buildRunner.js instead (under that
//    job's own JOB_ROOT/<id> dir), so each build's daemon registry is
//    isolated and gets wiped by the same TTL sweep as the rest of the job.
const GRADLE_RO_DEP_CACHE = process.env.GRADLE_RO_DEP_CACHE || path.join(os.tmpdir(), 'apk-builder-cache', 'gradle-ro-cache');

// Gradle's *local build cache* (what --build-cache actually populates) is a
// separate thing from the dependency cache above, but shares the same
// "safe to share across concurrent jobs" property — see
// src/shared-build-cache-init.gradle for why it needs its own init script
// to get redirected here instead of following GRADLE_USER_HOME.
const GRADLE_SHARED_BUILD_CACHE_DIR = process.env.GRADLE_SHARED_BUILD_CACHE_DIR || path.join(os.tmpdir(), 'apk-builder-cache', 'gradle-build-cache');

// Shared, persistent cache of fully-resolved node_modules trees, keyed by a
// hash of package-lock.json (+ a few env fingerprints) — see src/depCache.js.
// This is a different lever than NPM_CACHE_DIR above: the npm cache still
// makes a fresh `npm ci` fast (no re-download), but it still spends real
// wall-clock time re-linking/resolving the tree from tarballs every build.
// When two builds share the exact same lockfile (extremely common — most
// uploads are the same template project rebuilt, or share the same
// Capacitor/React boilerplate), this skips `npm ci` entirely and just
// reuses the already-linked node_modules via hardlinks.
const DEP_CACHE_DIR = process.env.DEP_CACHE_DIR || path.join(os.tmpdir(), 'apk-builder-cache', 'node-modules-cache');
// Bounds disk usage: oldest-used cache entries are evicted once this many
// distinct lockfile hashes have accumulated.
const DEP_CACHE_MAX_ENTRIES = parseInt(process.env.DEP_CACHE_MAX_ENTRIES || '8', 10);

// Real OOM prevention, not just a job-count ceiling. MAX_CONCURRENT_BUILDS
// caps how many builds are *allowed* to run at once, but two builds that
// are each individually within budget can still combine to exceed the
// container's actual RAM if the host is smaller than assumed, or if
// something else running in the container is using more than expected at
// that exact moment. This is a second, independent gate checked against
// real-time os.freemem() immediately before starting any new build — see
// buildRunner.js's pump(). A build that's ready to start but doesn't have
// enough headroom waits and is re-checked, instead of starting and risking
// the whole container getting OOM-killed.
const MIN_FREE_MEMORY_MB = parseInt(process.env.MIN_FREE_MEMORY_MB || '512', 10);

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

  NPM_CACHE_DIR,
  GRADLE_RO_DEP_CACHE,
  GRADLE_SHARED_BUILD_CACHE_DIR,
  DEP_CACHE_DIR,
  DEP_CACHE_MAX_ENTRIES,
  MIN_FREE_MEMORY_MB,
};
