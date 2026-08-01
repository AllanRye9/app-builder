'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { log, notice, setStatus, setQueuePosition } = require('./jobStore');
const { MAX_CONCURRENT_BUILDS, BUILD_TIMEOUT_MS } = require('./config');

const APP_ID = process.env.APP_ID || 'com.builder.app';
const APP_NAME = process.env.APP_NAME || 'MyApp';
const CAPACITOR_MAJOR = process.env.CAPACITOR_MAJOR || '7';

const queue = [];
let running = 0;

function enqueue(job) {
  queue.push(job);
  pump();
  broadcastQueuePositions();
}

// Re-announce every waiting job's position after any change, so the
// dashboard can show "3rd in line" and have it count down live.
function broadcastQueuePositions() {
  queue.forEach((job, i) => setQueuePosition(job, i + 1));
}

function pump() {
  while (running < MAX_CONCURRENT_BUILDS && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    setQueuePosition(job, 0);
    runBuild(job).finally(() => {
      running -= 1;
      pump();
      broadcastQueuePositions();
    });
  }
}

function detectWebDir(projectDir) {
  for (const d of ['dist', 'build', 'www', 'out']) {
    const full = path.join(projectDir, d);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return d;
  }
  return null;
}

// Adds a base permission set if the generated manifest has none at all —
// most React/Vite starters have no opinion on Android permissions, and an
// app with zero permissions can't reach the network at all.
function patchManifestIfNeeded(job, androidDir) {
  const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) return;

  const xml = fs.readFileSync(manifestPath, 'utf8');
  if (xml.includes('android.permission.INTERNET')) return;

  const permissions = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ];
  const inserted = permissions.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
  const patched = xml.replace(/<manifest([^>]*)>/, (m, attrs) => `<manifest${attrs}>\n${inserted}`);

  fs.writeFileSync(manifestPath, patched);
  log(job, 'Patched AndroidManifest.xml with base permissions (none were declared).');
  notice(job, {
    level: 'info',
    title: 'Added base permissions',
    message: 'AndroidManifest.xml had no permissions declared, so INTERNET, network state, location, and storage were added automatically.',
  });
}

async function runBuild(job) {
  const projectDir = job.projectDir;
  const androidDir = path.join(projectDir, 'android');

  let currentChild = null;
  let timedOut = false;
  const overallTimer = setTimeout(() => {
    timedOut = true;
    if (currentChild) {
      // Negative pid = kill the whole process group, not just the immediate
      // child. Gradle forks its own JVM worker processes even with
      // --no-daemon; killing only the wrapper script would leave those
      // orphaned instead of terminated — harmless once, but this container
      // stays alive across many builds, so orphans from repeated timeouts
      // would slowly accumulate. Requires the child to have been spawned
      // with `detached: true` (see run() below) so it's its own group leader.
      try {
        process.kill(-currentChild.pid, 'SIGKILL');
      } catch {
        // Group may have already exited on its own between the timer firing
        // and this running — fine, nothing left to kill.
      }
    }
  }, BUILD_TIMEOUT_MS);

  // Runs one command to completion, streaming its output into the job log
  // line-by-line as it happens (not just at the end) — this is what the
  // frontend's live log view is actually watching.
  function run(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
      log(job, `$ ${command} ${args.join(' ')}`);

      // This server's own container has NODE_ENV=production set (see
      // Dockerfile) — but that must NOT leak into the uploaded project's
      // own npm install/build. npm can treat NODE_ENV=production as "skip
      // devDependencies", and a project's build tool (vite, react-scripts,
      // webpack-cli, ...) almost always lives in devDependencies by
      // convention. Left inherited, every uploaded project's build tool
      // would silently never get installed, and `npm run build` would fail
      // with "command not found" (exit 127).
      //
      // Deleting NODE_ENV here is defense in depth, but it's not sufficient
      // on its own — omission of devDependencies can also come from an
      // .npmrc (project-level or baked into the image) or an
      // NPM_CONFIG_PRODUCTION/NPM_CONFIG_OMIT env var, neither of which this
      // deletion touches. The actual fix is forcing `--include=dev` on the
      // install/ci call below, which overrides any of those sources —
      // see the call site.
      const childEnv = { ...process.env, ...(opts.env || {}) };
      delete childEnv.NODE_ENV;

      const child = spawn(command, args, {
        cwd: opts.cwd || projectDir,
        env: childEnv,
        detached: true, // own process group, so a timeout kill can take any subprocesses it forked with it
      });
      currentChild = child;

      function pipeLines(stream) {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString();
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.trim()) log(job, line);
          }
        });
        stream.on('close', () => {
          if (buffer.trim()) log(job, buffer);
        });
        // A stream-level error is rare but would otherwise be an unhandled
        // 'error' event — which crashes the whole Node process, not just
        // this one job. One flaky build should never be able to take down
        // every other build sharing this container.
        stream.on('error', () => {});
      }
      pipeLines(child.stdout);
      pipeLines(child.stderr);

      child.on('error', (err) => {
        currentChild = null;
        reject(err);
      });

      child.on('close', (code) => {
        currentChild = null;
        if (timedOut) {
          reject(new Error(`Build timed out after ${Math.round(BUILD_TIMEOUT_MS / 1000)}s.`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} ${args.join(' ')} exited with code ${code}.`));
        }
      });
    });
  }

  try {
    setStatus(job, 'building');

    const hasLockfile = fs.existsSync(path.join(projectDir, 'package-lock.json'));
    // --include=dev is explicit and outranks any NODE_ENV, .npmrc
    // "production=true"/"omit=dev", or NPM_CONFIG_* env var that might
    // otherwise cause devDependencies (the project's own build tool) to be
    // skipped — see the comment on childEnv above for why relying on
    // deleting NODE_ENV alone isn't enough.
    await run('npm', [...(hasLockfile ? ['ci'] : ['install']), '--include=dev']);
    await run('npm', ['run', 'build']);

    const webDir = detectWebDir(projectDir);
    if (!webDir) {
      throw new Error("Couldn't find a web build output folder (looked for dist/, build/, www/, out/).");
    }
    log(job, `Detected web build output at ${webDir}/.`);

    await run('npm', [
      'install', '--no-save',
      `@capacitor/core@${CAPACITOR_MAJOR}`,
      `@capacitor/cli@${CAPACITOR_MAJOR}`,
      `@capacitor/android@${CAPACITOR_MAJOR}`,
    ]);

    const hasExistingConfig =
      fs.existsSync(path.join(projectDir, 'capacitor.config.json')) ||
      fs.existsSync(path.join(projectDir, 'capacitor.config.ts'));

    if (hasExistingConfig) {
      // `cap init` either refuses to run or overwrites an existing config —
      // neither is what we want here. A project that already ships its own
      // capacitor.config is telling us its actual appId/appName/webDir;
      // trust that instead of layering our own defaults on top of it.
      log(job, 'Found an existing capacitor.config — using it as-is instead of running cap init.');
      notice(job, {
        level: 'info',
        title: 'Using existing Capacitor config',
        message: "This project already had a capacitor.config file, so it was used as-is instead of generating a new one.",
      });
    } else {
      await run('npx', ['cap', 'init', APP_NAME, APP_ID, `--web-dir=${webDir}`]);
    }

    await run('npx', ['cap', 'add', 'android']);
    await run('npx', ['cap', 'copy', 'android']);

    patchManifestIfNeeded(job, androidDir);

    const gradlewPath = path.join(androidDir, 'gradlew');
    fs.chmodSync(gradlewPath, 0o755);
    // Using the absolute path (not './gradlew') is deliberate: Node resolves
    // a relative command against the *calling process's* cwd, not the
    // spawned child's `cwd` option — './gradlew' here would actually look
    // for gradlew next to the server's own working directory, not inside
    // the project. The absolute path sidesteps that ambiguity entirely.
    await run(gradlewPath, ['assembleDebug', '--no-daemon'], { cwd: androidDir });

    const apkSourcePath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    if (!fs.existsSync(apkSourcePath)) {
      throw new Error('Gradle reported success but no APK was found at the expected output path.');
    }

    fs.mkdirSync(job.outputDir, { recursive: true });
    const finalApkPath = path.join(job.outputDir, 'app.apk');
    fs.copyFileSync(apkSourcePath, finalApkPath);
    job.apkPath = finalApkPath;

    log(job, 'Build succeeded.');
    setStatus(job, 'success');
  } catch (err) {
    log(job, `ERROR: ${err.message}`);
    setStatus(job, 'failed', err.message);
  } finally {
    clearTimeout(overallTimer);
  }
}

module.exports = { enqueue };
