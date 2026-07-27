'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  DOCKER_IMAGE, BUILD_MEMORY_LIMIT, BUILD_CPU_LIMIT, BUILD_TIMEOUT_MS,
  JOB_ROOT, HOST_JOB_ROOT,
} = require('./config');
const { log, setStatus } = require('./jobStore');

// Translate a path this process sees (under JOB_ROOT) into the equivalent
// path on the real Docker host (under HOST_JOB_ROOT). See config.js for why
// this matters — it's what fixes the classic
// "cd: /project: No such file or directory" failure when this server itself
// runs inside a container and needs the *host* daemon to bind-mount a job's
// files into a sibling build container.
function toHostPath(containerPath) {
  const relative = path.relative(JOB_ROOT, containerPath);
  return path.join(HOST_JOB_ROOT, relative);
}

function runBuild(job) {
  return new Promise((resolve) => {
    fs.mkdirSync(job.outputDir, { recursive: true });
    setStatus(job, 'building');
    log(job, `Starting Docker build (image: ${DOCKER_IMAGE}).`);

    const hostProjectDir = toHostPath(job.projectDir);
    const hostOutputDir = toHostPath(job.outputDir);

    if (hostProjectDir !== job.projectDir) {
      log(job, `Mounting host path ${hostProjectDir} -> /project (translated from ${job.projectDir}).`);
    }

    const args = [
      'run', '--rm',
      '--memory', BUILD_MEMORY_LIMIT,
      '--cpus', BUILD_CPU_LIMIT,
      // Note: the build needs network access (npm install, Gradle/SDK
      // downloads), so we can't run with --network none. Isolation instead
      // comes from the container being ephemeral (--rm), resource-capped,
      // and torn down after each job — never re-run inside a live container.
      '-v', `${hostProjectDir}:/project`,
      '-v', `${hostOutputDir}:/output`,
      DOCKER_IMAGE,
    ];

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timeout = setTimeout(() => {
      log(job, `Build exceeded ${Math.round(BUILD_TIMEOUT_MS / 1000)}s timeout — killing container.`);
      child.kill('SIGKILL');
    }, BUILD_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => log(job, l));
    });
    child.stderr.on('data', (chunk) => {
      chunk.toString('utf8').split(/\r?\n/).filter(Boolean).forEach((l) => log(job, l));
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      setStatus(job, 'failed', `Failed to start Docker: ${err.message}`);
      log(job, `ERROR: ${err.message}`);
      resolve();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const apkPath = path.join(job.outputDir, 'app.apk');
      if (code === 0 && fs.existsSync(apkPath)) {
        job.apkPath = apkPath;
        log(job, 'Build succeeded. APK is ready for download.');
        setStatus(job, 'success');
      } else {
        setStatus(job, 'failed', `Build process exited with code ${code}.`);
        log(job, `Build failed (exit code ${code}).`);
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Bounded-concurrency queue
// ---------------------------------------------------------------------------
const { MAX_CONCURRENT_BUILDS } = require('./config');
const queue = [];
let running = 0;

function enqueue(job) {
  queue.push(job);
  log(job, `Queued (position ${queue.length}).`);
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT_BUILDS && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    runBuild(job).finally(() => {
      running -= 1;
      pump();
    });
  }
}

module.exports = { enqueue };
