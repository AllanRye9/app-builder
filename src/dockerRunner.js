import { spawn } from 'child_process';

// --- Docker-outside-of-Docker build orchestration --------------------------
// Runs docker/android-build's image once per job (see that Dockerfile's
// ENTRYPOINT — build.sh). This process talks to the HOST's Docker daemon
// over a bind-mounted socket (docker-compose.yml), so hostProjectDir/
// hostOutputDir passed in here must already be host-visible paths — see
// config.js's toHostPath().

const PROBE_TIMEOUT_MS = 8000;
const MAX_LOG_CHARS = 20000;
const NOTICE_PREFIX = '##NOTICE##';

function containerName(jobId) {
  const safe = String(jobId).replace(/[^a-zA-Z0-9_.-]/g, '');
  return `apk-build-${safe}`;
}

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

// Resolves with { logTail } on a zero exit code, rejects with an Error
// (message is safe to show the user / store as job.error) otherwise.
// onLine(text) is called for every plain log line (in original order);
// onNotice({level,title,message}) for every "##NOTICE## {json}" line
// build.sh emits.
export function runAndroidBuild({
  jobId,
  dockerBin = 'docker',
  image,
  hostProjectDir,
  hostOutputDir,
  timeoutMs,
  onLine,
  onNotice,
}) {
  return new Promise((resolve, reject) => {
    const name = containerName(jobId);
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '-v',
      `${hostProjectDir}:/project`,
      '-v',
      `${hostOutputDir}:/output`,
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
    let partial = '';

    const handleChunk = (chunk) => {
      const text = chunk.toString();
      logTail = (logTail + text).slice(-MAX_LOG_CHARS);
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop(); // keep the trailing partial line for the next chunk
      for (const line of lines) {
        handleLine(line);
      }
    };

    const handleLine = (line) => {
      if (line.startsWith(NOTICE_PREFIX)) {
        const jsonPart = line.slice(NOTICE_PREFIX.length).trim();
        try {
          onNotice?.(JSON.parse(jsonPart));
          return;
        } catch {
          // Malformed marker line — fall through and surface it as a plain
          // log line instead of silently swallowing it.
        }
      }
      onLine?.(line);
    };

    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);

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
      if (partial) handleLine(partial);
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
