import { useCallback, useRef, useState } from 'react';
import Dropzone from './components/Dropzone.jsx';
import JobTicket from './components/JobTicket.jsx';
import ToastStack from './components/ToastStack.jsx';
import SystemStatusBar from './components/SystemStatusBar.jsx';
import StructureGuide from './components/StructureGuide.jsx';
import PermissionsConfirmModal from './components/PermissionsConfirmModal.jsx';
import ErrorAssistPanel from './components/ErrorAssistPanel.jsx';
import SidePanel from './components/SidePanel.jsx';
import VisitorStats from './components/VisitorStats.jsx';
import BrandMark from './components/BrandMark.jsx';
import { uploadZip, askAssist } from './api.js';

let nextTempId = 0;

export default function App() {
  // Each entry: { tempId, id, fileName, fileSize, status, error, queuePosition, downloadReady }
  // tempId exists from the moment a file is picked (client-side, before the
  // server has assigned a real job id) so the card can appear instantly
  // while the upload is still in flight — the whole point of a
  // multi-tasking dashboard is that starting build #2 never waits on #1.
  const [jobs, setJobs] = useState([]);
  const [notices, setNotices] = useState([]);
  // Applies to whatever's uploaded next — chosen by the person building the
  // app in the confirmation pop-up (components/PermissionsConfirmModal.jsx),
  // never invented by the server.
  const [permissions, setPermissions] = useState([]);
  // Files sit here from the moment they're picked/dropped until the
  // permissions pop-up is confirmed — nothing is sent to the server and no
  // build starts before that confirmation.
  const [pendingFiles, setPendingFiles] = useState(null);
  // The right side panel (ErrorAssistPanel) only exists at all while this is
  // set — it appears the moment a build fails and disappears when closed or
  // when that ticket is dismissed. { id, tempId, fileName, error } | null
  const [activeErrorJob, setActiveErrorJob] = useState(null);
  const [assistMessages, setAssistMessages] = useState([]);
  const [assistInput, setAssistInput] = useState('');
  const [assistBusy, setAssistBusy] = useState(false);
  const nextNoticeId = useRef(0);
  const notifyAsked = useRef(false);

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
    // Dismissing the ticket a chat is currently scoped to closes the panel
    // too — nothing left for it to reference.
    setActiveErrorJob((prev) => (prev && prev.tempId === tempId ? null : prev));
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
  // pop-up instead of uploading right away.
  function handleFilesSelected(files) {
    setPendingFiles(files);
  }

  function cancelPendingFiles() {
    setPendingFiles(null);
  }

  // Called only once the pop-up's Confirm button is pressed — this is what
  // actually starts the upload/build for the pending batch.
  function confirmPendingFiles() {
    const files = pendingFiles;
    setPendingFiles(null);
    if (!files || files.length === 0) return;

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
        });
    });
  }

  function handleRejectedFile(message) {
    pushToast({ level: 'warning', title: 'Not accepted', message });
  }

  function handleJobDone(tempId, fileName, status, error) {
    if (status === 'success') {
      pushToast({ level: 'success', title: 'Build complete', message: `${fileName} is ready to download.` });
      notifyBrowser('Build complete', `${fileName} is ready to download.`);
    } else {
      const message = error || `${fileName} failed to build.`;
      pushToast({ level: 'error', title: 'Build failed', message });
      notifyBrowser('Build failed', message);
      // Surface the AI-assist panel for this failure automatically — the
      // whole point is not having to go looking for it.
      const job = jobs.find((j) => j.tempId === tempId);
      if (job) openAssistFor({ ...job, error: message });
    }
  }

  // Opens (or re-opens) the AI-assist panel scoped to one specific failed
  // job — called both automatically on failure above, and from the "Ask AI
  // about this" button on any already-failed ticket (see JobTicket.jsx).
  function openAssistFor(job) {
    setActiveErrorJob({ id: job.id, tempId: job.tempId, fileName: job.fileName, error: job.error });
    setAssistMessages([]);
    setAssistInput('');
  }

  function closeAssistPanel() {
    setActiveErrorJob(null);
  }

  async function sendAssistQuestion() {
    const question = assistInput.trim();
    if (!question || !activeErrorJob || assistBusy) return;

    setAssistMessages((prev) => [...prev, { role: 'user', text: question }]);
    setAssistInput('');
    setAssistBusy(true);
    try {
      const { answer, aiAvailable } = await askAssist(activeErrorJob.id, question);
      setAssistMessages((prev) => [...prev, { role: 'assistant', text: answer, aiAvailable }]);
    } catch (err) {
      setAssistMessages((prev) => [...prev, { role: 'assistant', text: err.message, aiAvailable: false }]);
    } finally {
      setAssistBusy(false);
    }
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
    <div className="app-frame">
      <div className="app-layout">
        <ToastStack notices={notices} onDismiss={dismissToast} />

        <aside className="side-panel side-panel-left hide-scrollbar" aria-label="Project structure guide">
          <SidePanel title="Project structure guide">
            <StructureGuide />
          </SidePanel>
        </aside>

        <div className="center-scroll hide-scrollbar">
          <main className="app-shell">
            <header className="floor-header">
              <div className="eyebrow"><BrandMark />apkit<span className="eyebrow-sep">·</span>build floor</div>
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
                    onUpdate={(patch) => patchJob(job.tempId, patch)}
                    onDone={(status, error) => handleJobDone(job.tempId, job.fileName, status, error)}
                    onNotice={pushToast}
                    onRemove={() => removeJob(job.tempId)}
                    onAskAI={openAssistFor}
                  />
                ))
              )}
            </div>

            <footer className="app-footer">
              Builds run with capped CPU/memory in ephemeral containers, destroyed after each job.
            </footer>
          </main>
        </div>

        {activeErrorJob && (
          <aside className="side-panel side-panel-right hide-scrollbar" aria-label="AI build assistant">
            <ErrorAssistPanel
              job={activeErrorJob}
              messages={assistMessages}
              input={assistInput}
              onInputChange={setAssistInput}
              onSend={sendAssistQuestion}
              busy={assistBusy}
              onClose={closeAssistPanel}
            />
          </aside>
        )}
      </div>
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
