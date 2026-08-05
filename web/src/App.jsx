import { useCallback, useEffect, useRef, useState } from 'react';
import Dropzone from './components/Dropzone.jsx';
import JobTicket from './components/JobTicket.jsx';
import ToastStack from './components/ToastStack.jsx';
import SystemStatusBar from './components/SystemStatusBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ThemeSwitcher from './components/ThemeSwitcher.jsx';
import ErrorAssistant from './components/ErrorAssistant.jsx';
import PermissionsConfirmModal from './components/PermissionsConfirmModal.jsx';
import IntroModal from './components/IntroModal.jsx';
import AuthScreen from './components/AuthScreen.jsx';
import BrandMark from './components/BrandMark.jsx';
import VisitorStats from './components/VisitorStats.jsx';
import { uploadZip, fetchMe, logout as apiLogout } from './api.js';
import { getToken, setToken, clearToken } from './lib/auth.js';
import { getStoredTheme, applyTheme } from './lib/theme.js';

let nextTempId = 0;

const SIDEBAR_COLLAPSED_KEY = 'apkit:sidebarCollapsed';
const INTRO_SEEN_KEY = 'apkit:introSeen';

export default function App() {
  const [authState, setAuthState] = useState('checking'); // 'checking' | 'signedOut' | 'signedIn'
  const [user, setUser] = useState(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setAuthState('signedOut');
      return;
    }
    fetchMe()
      .then((u) => { setUser(u); setAuthState('signedIn'); })
      .catch(() => { clearToken(); setAuthState('signedOut'); });
  }, []);

  function handleAuthenticated(token, authedUser) {
    setToken(token);
    setUser(authedUser);
    setAuthState('signedIn');
  }

  function handleLogout() {
    apiLogout();
    clearToken();
    setUser(null);
    setAuthState('signedOut');
  }

  if (authState === 'checking') {
    return (
      <div className="auth-frame">
        <div className="auth-checking" aria-live="polite">Checking your session…</div>
      </div>
    );
  }

  if (authState === 'signedOut') {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return <Dashboard user={user} onLogout={handleLogout} />;
}

function Dashboard({ user, onLogout }) {
  // Each entry: { tempId, id, fileName, fileSize, status, error, queuePosition, downloadReady }
  // tempId exists from the moment a file is picked (client-side, before the
  // server has assigned a real job id) so the card can appear instantly
  // while the upload is still in flight.
  const [jobs, setJobs] = useState([]);
  const [notices, setNotices] = useState([]);
  // Chosen in the confirm modal (see PermissionsConfirmModal.jsx) — carried
  // over as the default for the next batch, but never applied to anything
  // until that batch is explicitly confirmed.
  const [permissions, setPermissions] = useState([]);
  // Files staged after a drop/pick, waiting on the confirm modal — nothing
  // is uploaded until handleConfirmPending runs.
  const [pendingFiles, setPendingFiles] = useState([]);
  // The most recent build failure / rejected upload — drives whether the
  // right-hand error-assistant panel exists at all.
  const [errorContext, setErrorContext] = useState(null);

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const [section, setSection] = useState('floor');
  const [theme, setTheme] = useState(getStoredTheme);
  const [showIntro, setShowIntro] = useState(() => {
    try { return localStorage.getItem(INTRO_SEEN_KEY) !== '1'; } catch { return true; }
  });

  const nextNoticeId = useRef(0);
  const notifyAsked = useRef(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }

  function dismissIntro() {
    setShowIntro(false);
    try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch { /* ignore */ }
  }

  function replayIntro() {
    setShowIntro(true);
  }

  const pushToast = useCallback((payload) => {
    nextNoticeId.current += 1;
    setNotices((prev) => [...prev, { ...payload, id: nextNoticeId.current }]);
  }, []);

  const dismissToast = useCallback((id) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // useCallback (stable identity across renders, since setJobs itself never
  // changes) so JobTicket's props stay referentially stable and its
  // React.memo actually prevents re-rendering every other ticket whenever
  // one job updates — see JobTicket.jsx.
  const patchJob = useCallback((tempId, patch) => {
    setJobs((prev) => prev.map((j) => (j.tempId === tempId ? { ...j, ...patch } : j)));
  }, []);

  const removeJob = useCallback((tempId) => {
    setJobs((prev) => prev.filter((j) => j.tempId !== tempId));
  }, []);

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

  // Staging step: a drop/pick no longer uploads anything by itself — it
  // just opens the permissions confirm modal. Nothing reaches the server
  // until handleConfirmPending runs.
  function handleFilesSelected(files) {
    setPendingFiles(files);
  }

  function handleCancelPending() {
    setPendingFiles([]);
  }

  function handleConfirmPending() {
    const files = pendingFiles;
    setPendingFiles([]);
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
        },
        ...prev,
      ]);

      uploadZip(file, permissions)
        .then((jobId) => patchJob(tempId, { id: jobId, status: 'validating' }))
        .catch((err) => {
          patchJob(tempId, { status: 'failed', error: err.message });
          pushToast({ level: 'error', title: `${file.name} rejected`, message: err.message });
          setErrorContext({ fileName: file.name, errorMessage: err.message, logTail: [] });
        });
    });
  }

  function handleRejectedFile(message) {
    pushToast({ level: 'warning', title: 'Not accepted', message });
  }

  const handleJobDone = useCallback((tempId, fileName, status, error, logTail) => {
    if (status === 'success') {
      pushToast({ level: 'success', title: 'Build complete', message: `${fileName} is ready to download.` });
      notifyBrowser('Build complete', `${fileName} is ready to download.`);
    } else {
      const message = error || `${fileName} failed to build.`;
      pushToast({ level: 'error', title: 'Build failed', message });
      notifyBrowser('Build failed', message);
      setErrorContext({ fileName, errorMessage: message, logTail: logTail || [] });
    }
  }, [pushToast]);

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
    <div className="app-frame">
      <div className="app-layout">
        <ToastStack notices={notices} onDismiss={dismissToast} />

        <Sidebar
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          section={section}
          onSelectSection={setSection}
          user={user}
          onLogout={onLogout}
          theme={theme}
          onThemeChange={setTheme}
          onReplayIntro={replayIntro}
        />

        <div className="center-scroll hide-scrollbar">
          <main className="app-shell">
            <header className="floor-header">
              <div className="eyebrow-row">
                <div className="eyebrow"><BrandMark />apkit<span className="eyebrow-sep">·</span>build floor</div>
                <ThemeSwitcher theme={theme} onChange={setTheme} compact />
              </div>
              <h1>Turn React, Kotlin, or Java projects into APKs, all at once</h1>
              <p className="sub">
                Drop in a React/Vite web project (built via Capacitor) or a native Kotlin/Java
                Android project (built directly with its own Gradle wrapper) — each runs in its
                own isolated, disposable container with a pre-configured Android SDK.
              </p>
              <VisitorStats />
            </header>

            <SystemStatusBar />

            <Dropzone onFilesSelected={handleFilesSelected} onReject={handleRejectedFile} />

            {jobs.length > 0 && (
              <div className="stats-bar" aria-label="Build floor summary">
                <Stat value={counts.building} label="building" tone="active" />
                <Stat value={counts.queued} label="waiting" tone="queued" />
                <Stat value={counts.done} label="done" tone="done" />
                {counts.failed > 0 && <Stat value={counts.failed} label="failed" tone="failed" />}
              </div>
            )}

            <div className="ticket-list hide-scrollbar">
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
                    onUpdate={patchJob}
                    onDone={handleJobDone}
                    onNotice={pushToast}
                    onRemove={removeJob}
                  />
                ))
              )}
            </div>

            <footer className="app-footer">
              Builds run with capped CPU/memory in ephemeral containers, destroyed after each job.
            </footer>
          </main>
        </div>

        <ErrorAssistant errorContext={errorContext} onDismiss={() => setErrorContext(null)} />
      </div>

      <PermissionsConfirmModal
        files={pendingFiles}
        selected={permissions}
        onChange={setPermissions}
        onConfirm={handleConfirmPending}
        onCancel={handleCancelPending}
      />

      <IntroModal open={showIntro} onClose={dismissIntro} />
    </div>
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
