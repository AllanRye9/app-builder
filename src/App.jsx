import { useCallback, useEffect, useRef, useState } from 'react';
import Dropzone from './components/Dropzone.jsx';
import JobTicket from './components/JobTicket.jsx';
import ToastStack from './components/ToastStack.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { uploadAndStartBuild, fetchServerConfig } from './api.js';

let nextTempId = 0;

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [notices, setNotices] = useState([]);
  const [serverConfig, setServerConfig] = useState(null);
  const nextNoticeId = useRef(0);
  const notifyAsked = useRef(false);

  useEffect(() => {
    fetchServerConfig().then(setServerConfig);
  }, []);

  const configMessage = getConfigMessage(serverConfig);

  const pushToast = useCallback((payload) => {
    nextNoticeId.current += 1;
    setNotices((prev) => [...prev, { ...payload, id: nextNoticeId.current }]);
  }, []);

  const dismissToast = useCallback((id) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  function patchJob(tempId, patch) {
    setJobs((prev) => prev.map((j) => (j.tempId === tempId ? { ...j, ...patch } : j)));
  }

  function removeJob(tempId) {
    setJobs((prev) => prev.filter((j) => j.tempId !== tempId));
  }

  async function ensureNotifyPermission() {
    if (notifyAsked.current) return;
    notifyAsked.current = true;
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // In-app toast still covers completion either way.
      }
    }
  }

  function handleFilesSelected(files) {
    ensureNotifyPermission();
    files.forEach((file) => {
      const tempId = `t${nextTempId++}`;
      setJobs((prev) => [
        {
          tempId,
          id: null,
          fileName: file.name,
          fileSize: file.size,
          status: 'uploading',
          error: null,
          apkUrl: null,
          runUrl: null,
        },
        ...prev,
      ]);

      uploadAndStartBuild(file)
        .then((jobId) => patchJob(tempId, { id: jobId, status: 'validating' }))
        .catch((err) => {
          patchJob(tempId, { status: 'failed', error: err.message });
          pushToast({ level: 'error', title: `${file.name} rejected`, message: err.message });
        });
    });
  }

  function handleJobDone(tempId, fileName, status, error) {
    if (status === 'success') {
      pushToast({ level: 'success', title: 'Build complete', message: `${fileName} is ready to download.` });
      notifyBrowser('Build complete', `${fileName} is ready to download.`);
    } else {
      const message = error || `${fileName} failed to build.`;
      pushToast({ level: 'error', title: 'Build failed', message });
      notifyBrowser('Build failed', message);
    }
  }

  const counts = jobs.reduce(
    (acc, j) => {
      if (j.status === 'building') acc.building += 1;
      else if (j.status === 'success') acc.done += 1;
      else if (j.status === 'failed') acc.failed += 1;
      else acc.queued += 1;
      return acc;
    },
    { building: 0, queued: 0, done: 0, failed: 0 }
  );

  return (
    <main className="app-shell">
      <ToastStack notices={notices} onDismiss={dismissToast} />

      <header className="floor-header">
        <div className="eyebrow"><span className="dot" />apk-builder — one server + GitHub Actions</div>
        <h1>Turn React projects into APKs, all at once</h1>
        <p className="sub">
          Drop in as many project archives as you like. Each one builds on a fresh GitHub Actions
          runner — no image to go stale, nothing to redeploy when a new one starts.
        </p>
      </header>

      <ErrorBanner message={configMessage} />

      <Dropzone onFilesSelected={handleFilesSelected} />

      {jobs.length > 0 && (
        <div className="stats-bar" aria-label="Build floor summary">
          <Stat value={counts.building} label="building" tone="active" />
          <Stat value={counts.queued} label="starting" tone="queued" />
          <Stat value={counts.done} label="done" tone="done" />
          {counts.failed > 0 && <Stat value={counts.failed} label="failed" tone="failed" />}
        </div>
      )}

      <div className="ticket-list">
        {jobs.length === 0 ? (
          <div className="empty-floor">
            <div className="empty-floor-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.4" />
                <path d="M7 7.2h.01M9.4 7.2h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </div>
            <div className="empty-floor-title">The floor is empty</div>
            <div className="empty-floor-sub">Drop a project above to start your first build.</div>
          </div>
        ) : (
          jobs.map((job) => (
            <JobTicket
              key={job.tempId}
              job={job}
              onUpdate={(patch) => patchJob(job.tempId, patch)}
              onDone={(status, error) => handleJobDone(job.tempId, job.fileName, status, error)}
              onRemove={() => removeJob(job.tempId)}
            />
          ))
        )}
      </div>

      <footer className="app-footer">
        Builds run on GitHub-hosted Ubuntu runners with a 20-minute timeout, torn down after each job.
      </footer>
    </main>
  );
}

function Stat({ value, label, tone }) {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function getConfigMessage(serverConfig) {
  if (!serverConfig) return '';
  const problems = [];
  if (serverConfig.missingConfigFields?.length > 0) {
    problems.push(`missing ${serverConfig.missingConfigFields.join(', ')} in config.json`);
  }
  if (!serverConfig.storageAvailable) {
    problems.push('no writable storage directory available');
  }
  if (serverConfig.usingTemporaryCallbackSecret) {
    problems.push('callbackSecret is auto-generated and temporary — a build in progress will get stuck if this server restarts before it finishes, set a real callbackSecret in config.json to fix this');
  }
  if (problems.length === 0) return '';
  return `Server setup isn't finished yet (${problems.join('; ')}) — see the README for the config.json fields this needs.`;
}

function notifyBrowser(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    // eslint-disable-next-line no-new
    new Notification(title, { body });
  } catch {
    // Some browsers require a service worker for this — fine to skip.
  }
}
