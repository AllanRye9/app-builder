'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { log, notice, setStatus, setQueuePosition } = require('./jobStore');
const { MAX_CONCURRENT_BUILDS, BUILD_TIMEOUT_MS, NPM_CACHE_DIR, GRADLE_USER_HOME } = require('./config');

const APP_ID = process.env.APP_ID || 'com.builder.app';
const APP_NAME = process.env.APP_NAME || 'MyApp';
const CAPACITOR_MAJOR = process.env.CAPACITOR_MAJOR || '7';

// Created once at startup, shared by every job for the life of this
// container — see config.js for why these live outside JOB_ROOT.
fs.mkdirSync(NPM_CACHE_DIR, { recursive: true });
fs.mkdirSync(GRADLE_USER_HOME, { recursive: true });

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

// Depth-first search for files matching `matchFn`, skipping directories in
// `skipDirs` — callers pass different skip lists because "build/" means two
// different things here: for finding a *source* AndroidManifest.xml it's
// noise to avoid (Gradle's merged/intermediate manifests live under
// build/intermediates/...), but for finding the *APK* it's the only place
// the file will ever exist (build/outputs/apk/debug/...). Always skipping
// it unconditionally would make the APK search find nothing.
function findFilesRecursive(rootDir, matchFn, skipDirs) {
  const results = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (matchFn(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
  })(rootDir);
  return results;
}

// Used when searching for *source* files (AndroidManifest.xml) — dependency
// caches and Gradle's own intermediate build output are never what we want.
const SOURCE_SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.gradle', '.idea']);
// Used when searching for the *built APK* — 'build' must NOT be skipped
// here, since build/outputs/apk/debug/ is exactly where it lives. Still
// skip dependency caches, which are irrelevant and can be large.
const OUTPUT_SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', '.gradle', '.idea']);

// Adds ONLY the permissions the uploader actually asked for (job.permissions
// — already validated against a whitelist in src/permissions.js) to the
// given manifest. Never invents permissions on its own: an upload with no
// requested permissions leaves the manifest byte-for-byte as the uploader
// wrote it, because deciding what an app is allowed to do is the
// uploader's call, not this build's.
function patchManifestPermissions(job, manifestPath) {
  if (!job.permissions || job.permissions.length === 0) return;
  if (!fs.existsSync(manifestPath)) {
    log(job, `Requested permissions but no AndroidManifest.xml was found at ${manifestPath} to add them to.`);
    return;
  }

  const xml = fs.readFileSync(manifestPath, 'utf8');
  const missing = job.permissions.filter((p) => !xml.includes(`"${p}"`));
  if (missing.length === 0) {
    log(job, 'All requested permissions were already declared in AndroidManifest.xml.');
    return;
  }

  const inserted = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
  const patched = xml.replace(/<manifest([^>]*)>/, (m, attrs) => `<manifest${attrs}>\n${inserted}`);
  fs.writeFileSync(manifestPath, patched);

  log(job, `Added requested permission(s) to AndroidManifest.xml: ${missing.join(', ')}`);
  notice(job, {
    level: 'info',
    title: 'Applied requested permissions',
    message: `Added to AndroidManifest.xml: ${missing.join(', ')}.`,
  });
}

async function runBuild(job) {
  const projectDir = job.projectDir;

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

      // Shared, persistent caches (see config.js) — set unconditionally.
      // Harmless for commands that don't read them, and means npm/Gradle
      // never re-fetch a dependency this container has already downloaded
      // for a previous job, which is where most of a build's wall-clock
      // time otherwise goes.
      childEnv.NPM_CONFIG_CACHE = NPM_CACHE_DIR;
      childEnv.GRADLE_USER_HOME = GRADLE_USER_HOME;

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

  // Runs the project's own Gradle wrapper with flags that speed up a
  // container-local build without changing what gets built:
  //  --no-daemon    required for the timeout-kill logic above to be able to
  //                 reap every JVM process Gradle forks, not just leave a
  //                 daemon running past its own job's lifetime.
  //  --build-cache  reuses GRADLE_USER_HOME's shared build cache across
  //                 jobs instead of recompiling unchanged tasks every time.
  // Deliberately NOT adding --parallel: MAX_CONCURRENT_BUILDS is already
  // sized against this container's total RAM (see config.js) assuming each
  // build is single-threaded on the Gradle side; letting Gradle itself
  // fan out extra parallel workers on top of that risks the exact OOM the
  // conservative default concurrency was chosen to avoid.
  function runGradle(gradlewPath, androidDir) {
    fs.chmodSync(gradlewPath, 0o755);
    return run(gradlewPath, ['assembleDebug', '--no-daemon', '--build-cache'], { cwd: androidDir });
  }

  try {
    setStatus(job, 'building');

    if (job.projectType === 'native-android') {
      await runNativeAndroidBuild(job, projectDir, run, runGradle);
    } else {
      await runCapacitorBuild(job, projectDir, run, runGradle);
    }

    log(job, 'Build succeeded.');
    setStatus(job, 'success');
  } catch (err) {
    log(job, `ERROR: ${err.message}`);
    setStatus(job, 'failed', err.message);
  } finally {
    clearTimeout(overallTimer);
  }
}

// ---------------------------------------------------------------------------
// Path A: a web project (React/Vite/etc.), wrapped into an Android shell via
// Capacitor.
// ---------------------------------------------------------------------------
async function runCapacitorBuild(job, projectDir, run, runGradle) {
  const androidDir = path.join(projectDir, 'android');

  const hasLockfile = fs.existsSync(path.join(projectDir, 'package-lock.json'));
  // --include=dev is explicit and outranks any NODE_ENV, .npmrc
  // "production=true"/"omit=dev", or NPM_CONFIG_* env var that might
  // otherwise cause devDependencies (the project's own build tool) to be
  // skipped. --prefer-offline/--no-audit/--no-fund trim network round trips
  // that don't affect what gets installed, just how long it takes.
  await run('npm', [
    ...(hasLockfile ? ['ci'] : ['install']),
    '--include=dev',
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
  ]);
  await run('npm', ['run', 'build']);

  const webDir = detectWebDir(projectDir);
  if (!webDir) {
    throw new Error("Couldn't find a web build output folder (looked for dist/, build/, www/, out/).");
  }
  log(job, `Detected web build output at ${webDir}/.`);

  await run('npm', [
    'install', '--no-save', '--prefer-offline', '--no-audit', '--no-fund',
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

  patchManifestPermissions(job, path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml'));

  // Using the absolute path (not './gradlew') is deliberate: Node resolves
  // a relative command against the *calling process's* cwd, not the
  // spawned child's `cwd` option — './gradlew' here would actually look
  // for gradlew next to the server's own working directory, not inside
  // the project. The absolute path sidesteps that ambiguity entirely.
  await runGradle(path.join(androidDir, 'gradlew'), androidDir);

  const apkSourcePath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apkSourcePath)) {
    throw new Error('Gradle reported success but no APK was found at the expected output path.');
  }

  finalizeApk(job, apkSourcePath);
}

// ---------------------------------------------------------------------------
// Path B: a native Android project written in Kotlin and/or Java — its own
// Gradle project, built directly with no web/Capacitor step at all. The
// uploader's code is otherwise untouched: the only thing this build ever
// writes is permissions the uploader explicitly requested (see
// patchManifestPermissions).
// ---------------------------------------------------------------------------
async function runNativeAndroidBuild(job, projectDir, run, runGradle) {
  const gradlewPath = path.join(projectDir, 'gradlew');
  if (!fs.existsSync(gradlewPath)) {
    throw new Error('No gradlew found at the project root — a native Android project must include its Gradle wrapper.');
  }

  log(job, 'Native Kotlin/Java Android project detected — building directly with its own Gradle wrapper.');

  // A module's manifest can live at any <module>/src/main/AndroidManifest.xml
  // (usually just app/, but multi-module projects are common) — search for
  // all of them rather than assuming the module is named "app".
  const manifests = findFilesRecursive(projectDir, (name) => name === 'AndroidManifest.xml', SOURCE_SEARCH_SKIP_DIRS);
  for (const manifestPath of manifests) {
    patchManifestPermissions(job, manifestPath);
  }

  await runGradle(gradlewPath, projectDir);

  const apks = findFilesRecursive(
    path.join(projectDir),
    (name) => name.endsWith('.apk'),
    OUTPUT_SEARCH_SKIP_DIRS
  ).filter((p) => p.includes(`${path.sep}outputs${path.sep}apk${path.sep}debug${path.sep}`));

  if (apks.length === 0) {
    throw new Error('Gradle reported success but no debug APK was found under any module\'s build/outputs/apk/debug/.');
  }
  // Multiple modules could each produce a debug APK (e.g. an app module
  // plus a separate wear/instant module) — take the largest as the most
  // likely "main" app APK rather than guessing by name.
  apks.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  finalizeApk(job, apks[0]);
}

function finalizeApk(job, apkSourcePath) {
  fs.mkdirSync(job.outputDir, { recursive: true });
  const finalApkPath = path.join(job.outputDir, 'app.apk');
  fs.copyFileSync(apkSourcePath, finalApkPath);
  job.apkPath = finalApkPath;
}

module.exports = { enqueue };
