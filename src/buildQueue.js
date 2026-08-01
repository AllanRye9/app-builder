// A simple FIFO queue capping how many build containers run at once
// (MAX_CONCURRENT_BUILDS — see config.js). The frontend's Pipeline
// component has a dedicated "Queue" stage with a live position indicator
// (Nth in line), so jobs beyond the concurrency cap wait here rather than
// all starting containers simultaneously and overloading the host.
let running = 0;
let maxConcurrent = 2;
const waiting = []; // array of { jobId, onStart, onPositionChange }

export function configure({ maxConcurrentBuilds }) {
  maxConcurrent = maxConcurrentBuilds;
}

function notifyPositions() {
  waiting.forEach((entry, i) => entry.onPositionChange(i + 1));
}

function startNext() {
  if (running >= maxConcurrent || waiting.length === 0) return;
  const entry = waiting.shift();
  running += 1;
  notifyPositions();
  entry.onStart();
}

// Runs `task()` (an async function) respecting the concurrency cap.
// onPositionChange(position) is called immediately if the job has to wait,
// and again each time its place in line changes, until it starts.
export function schedule(jobId, task, { onPositionChange } = () => {}) {
  return new Promise((resolve, reject) => {
    const entry = {
      jobId,
      onPositionChange: onPositionChange || (() => {}),
      onStart: () => {
        task()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            startNext();
          });
      },
    };

    if (running < maxConcurrent) {
      running += 1;
      entry.onStart();
    } else {
      waiting.push(entry);
      notifyPositions();
    }
  });
}

// Removes a job that's still waiting (never started) from the queue — used
// when a job is cancelled/fails validation before ever reaching the front
// of the line. No-op if the job already started or isn't in the queue.
export function removeWaiting(jobId) {
  const idx = waiting.findIndex((e) => e.jobId === jobId);
  if (idx !== -1) waiting.splice(idx, 1);
  notifyPositions();
}
