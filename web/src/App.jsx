import { useCallback, useEffect, useRef, useState } from 'react';
import Dropzone from './components/Dropzone.jsx';
import JobTicket from './components/JobTicket.jsx';
import ToastStack from './components/ToastStack.jsx';
import PermissionsConfirmModal from './components/PermissionsConfirmModal.jsx';
import SystemStatusBar from './components/SystemStatusBar.jsx';
import Documentation from './components/Documentation.jsx';
import ThemeSwitcher from './components/ThemeSwitcher.jsx';
import VisitorStats from './components/VisitorStats.jsx';
import XPBar from './components/XPBar.jsx';
import Confetti from './components/Confetti.jsx';
import AuthGate from './components/AuthGate.jsx';
import { uploadZip, logout as apiLogout } from './api.js';
import { getToken, getStoredEmail, setAuth, clearAuth } from './lib/auth.js';
import { getStoredTheme, applyTheme } from './lib/theme.js';
import { getProgress, recordUpload, recordBuildResult, recordDocsView, recordStructureView, levelForXp, BADGES } from './lib/gamification.js';

let nextTempId = 0;

export default function App() {
  const [authToken, setAuthToken] = useState(getToken);
  const [authEmail, setAuthEmail] = useState(getStoredEmail);

  function handleAuthenticated(token, email) {
    setAuth(token, email);
    setAuthToken(token);
    setAuthEmail(email);
  }

  function handleLogout() {
    apiLogout();
    clearAuth();
    setAuthToken('');
    setAuthEmail('');
  }

  if (!authToken) {
    return <AuthGate onAuthenticated={handleAuthenticated} />;
  }

  return <BuildFloor authEmail={authEmail} onLogout={handleLogout} />;
}

function BuildFloor({ authEmail, onLogout }) {
  // Each entry: { tempId, id, fileName, fileSize, status, error, queuePosition, downloadReady }
  // tempId exists from the moment a file is picked (client-side, before the
  // server has assigned a real job id) so the card can appear instantly
  // while the upload is still in flight — the whole point of a
  // multi-tasking dashboard is that starting build #2 never waits on #1.
  const [jobs, setJobs] = useState([]);
  const [notices, setNotices] = useState([]);
  // Applies to whatever's uploaded next — chosen by the person building the
  // app, never invented by the server (see components/PermissionsConfirmModal.jsx).
  const [permissions, setPermissions] = useState([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [theme, setTheme] = useState(getStoredTheme);
  const [progress, setProgress] = useState(getProgress);
  const [confettiKey, setConfettiKey] = useState(0);
  const confettiTimer = useRef(null);
  const nextNoticeId = useRef(0);
  const notifyAsked = useRef(false);
  // Files sit here from the moment they're picked/dropped until the
  // permissions popup is confirmed — nothing is sent to the server and no
  // build starts before that confirmation.
  const [pendingFiles, setPendingFiles] = useState(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const pushToast = useCallback((payload) => {
    nextNoticeId.current += 1;
    setNotices((prev) => [...prev, { ...payload, id: nextNoticeId.current }]);
  }, []);

  const dismissToast = useCallback((id) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const celebrate = useCallback(() => {
    setConfettiKey((k) => k + 1);
    clearTimeout(confettiTimer.current);
    confettiTimer.current = setTimeout(() => setConfettiKey(0), 1700);
  }, []);

  // Applies the result of any gamification event: updates the XP bar,
  // and — only when something actually changed — surfaces a toast and a
  // confetti burst so leveling up or a new badge feels like an event, not
  // a silent number change buried in a collapsed panel.
  const applyGameResult = useCallback((result) => {
    if (!result) return;
    setProgress(result.state);
    if (result.leveledUp) {
      pushToast({
        level: 'success',
        title: `Level up! Now level ${levelForXp(result.state.xp)}`,
        message: 'Check the XP bar for your progress and badges.',
      });
      celebrate();
    }
    result.newBadges.forEach((id) => {
      const badge = BADGES.find((b) => b.id === id);
      if (badge) {
        pushToast({ level: 'success', title: `Badge unlocked: ${badge.label}`, message: badge.desc });
        celebrate();
      }
    });
  }, [pushToast, celebrate]);

  function openDocs() {
    setDocsOpen(true);
    applyGameResult(recordDocsView());
  }

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
        // Some browsers/contexts (e.g. insecure origins) reject this — the
        // in-app toast stack still covers completion either way.
      }
    }
  }

  // Called the instant files are picked/dropped — opens the permissions
  // popup instead of uploading right away.
  function handleFilesPicked(files) {
    setPendingFiles(files);
  }

  function cancelPendingFiles() {
    setPendingFiles(null);
  }

  // Called only once the popup's Confirm button is pressed — this is what
  // actually starts the upload/build for the pending batch.
  function confirmPendingFiles() {
    const files = pendingFiles;
    setPendingFiles(null);
    if (files && files.length > 0) startUploads(files);
  }

  function startUploads(files) {
    ensureNotifyPermission();
    files.forEach((file) => {
      const tempId = `t${nextTempId++}`;
      setJobs((prev) => [
        {
          tempId,
          id: null,
          file,
          fileName: file.name,
          fileSize: file.size,
          status: 'uploading',
          error: null,
          queuePosition: null,
          downloadReady: false,
          projectType: null,
        },
        ...prev,
      ]);
      applyGameResult(recordUpload());

      uploadZip(file, permissions)
        .then((jobId) => patchJob(tempId, { id: jobId, status: 'validating' }))
        .catch((err) => {
          patchJob(tempId, { status: 'failed', error: err.message });
          pushToast({ level: 'error', title: `${file.name} rejected`, message: err.message });
        });
    });
  }

  function handleJobDone(tempId, fileName, status, error, projectType) {
    if (status === 'success') {
      pushToast({ level: 'success', title: 'Build complete', message: `${fileName} is ready to download.` });
      notifyBrowser('Build complete', `${fileName} is ready to download.`);
      celebrate();
    } else {
      const message = error || `${fileName} failed to build.`;
      pushToast({ level: 'error', title: 'Build failed', message });
      notifyBrowser('Build failed', message);
    }
    applyGameResult(recordBuildResult(status, projectType));
  }

  const counts = jobs.reduce(
    (acc, j) => {
      if (j.status === 'building') acc.building += 1;
      else if (j.status === 'success') acc.done += 1;
      else if (j.status === 'failed') acc.failed += 1;
      else acc.queued += 1; // uploading | validating | queued
      return acc;
    },
    { building: 0, queued: 0, done: 0, failed: 0 }
  );

  return (
    <main className="app-shell">
      <ToastStack notices={notices} onDismiss={dismissToast} />
      {confettiKey > 0 && <Confetti key={confettiKey} />}

      <header className="floor-header">
        <div className="eyebrow-row">
          <div className="eyebrow"><span className="dot" />apk-builder — build floor</div>
          <div className="header-controls">
            <ThemeSwitcher theme={theme} onChange={setTheme} />
            <button type="button" className="docs-link" onClick={openDocs}>
              <span aria-hidden="true">📄</span> File structure docs
            </button>
            {authEmail && <span className="ticket-size" title={authEmail}>{authEmail}</span>}
            <button type="button" className="logout-link" onClick={onLogout}>Log out</button>
          </div>
        </div>
        <h1>Turn React, Kotlin, or Java projects into APKs, all at once</h1>
        <p className="sub">
          Drop in as many project archives as you like — a React/Vite web project (Capacitor) or a
          native Kotlin/Java Android project both work, each in its own disposable container.{' '}
          <button type="button" className="inline-link" onClick={openDocs}>
            See the required layout →
          </button>
        </p>

        <VisitorStats />
      </header>

      <Documentation open={docsOpen} onClose={() => setDocsOpen(false)} />

      <XPBar progress={progress} />

      <SystemStatusBar />

      <Dropzone onFilesSelected={handleFilesPicked} />

      <PermissionsConfirmModal
        open={pendingFiles !== null}
        files={pendingFiles || []}
        selected={permissions}
        onChange={setPermissions}
        onCancel={cancelPendingFiles}
        onConfirm={confirmPendingFiles}
      />

      {jobs.length > 0 && (
        <div className="stats-bar" aria-label="Build floor summary">
          <Stat value={counts.building} label="building" tone="active" />
          <Stat value={counts.queued} label="waiting" tone="queued" />
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
              onDone={(status, error) => handleJobDone(job.tempId, job.fileName, status, error, job.projectType)}
              onNotice={pushToast}
              onRemove={() => removeJob(job.tempId)}
              onStructureExpand={() => applyGameResult(recordStructureView())}
            />
          ))
        )}
      </div>

      <footer className="app-footer">
        Builds run with capped CPU/memory in ephemeral containers, destroyed after each job. ·{' '}
        <button type="button" className="inline-link" onClick={openDocs}>File structure docs</button>
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

// Best-effort OS-level notification for when the tab is backgrounded — the
// in-app toast already covers the foreground case. Silently does nothing
// anywhere this isn't supported or permitted; never blocks the build flow.
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
