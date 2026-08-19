import { memo, useCallback, useEffect, useRef, useState } from 'react';
import Pipeline from './Pipeline.jsx';
import LogPanel from './LogPanel.jsx';
import DownloadCard from './DownloadCard.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import FileTree from './FileTree.jsx';
import ProjectExplorer from './ProjectExplorer.jsx';
import ProjectEditorModal from './ProjectEditorModal.jsx';
import { streamLogs, pauseBuild, resumeBuild, cancelBuild, rebuildJob } from '../api.js';

// How often batched log lines are flushed into rendered state, in ms. A
// Gradle/npm build can emit hundreds of lines within a couple of seconds;
// without batching, each one triggers its own setState (a full array copy
// via spread, plus a re-render of this whole ticket and its children).
// Batching turns "one render + one O(n) copy per line" into "one render +
// one O(n) copy per LOG_FLUSH_MS window", which is the difference between
// roughly O(n^2) and O(n) total work over the life of a long build. Kept
// short enough that live tailing still feels instant.
const LOG_FLUSH_MS = 60;

// One ticket per build. Owns its own SSE subscription and log buffer — logs
// are only ever needed inside this card, so there's no reason to lift them
// into the parent's state and re-render the whole floor on every line.
// Only the small summary fields (status, error, queue position) are
// reported upward, for the stats bar and the toast/notification triggers.
function JobTicket({ job, onUpdate, onDone, onNotice, onRemove }) {
  const [logs, setLogs] = useState([]);
  const [stage, setStage] = useState('validating');
  const [expanded, setExpanded] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [buildStep, setBuildStep] = useState(null);
  const [buildProgress, setBuildProgress] = useState(0);
  const [cacheHit, setCacheHit] = useState(false);
  const [paused, setPaused] = useState(false);
  const [exitCode, setExitCode] = useState(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlMessage, setControlMessage] = useState(null);
  // Bumped on every rebuild — included in the SSE-subscribing effect's
  // dependency array so a rebuild (same job.id, freshly re-queued on the
  // server) opens a brand new log stream instead of reusing the closed one
  // from the previous attempt.
  const [buildKey, setBuildKey] = useState(0);
  // Which full-page editor is open for this ticket, if any: null | 'edit' | 'ai'.
  const [editorMode, setEditorMode] = useState(null);
  const doneFired = useRef(false);
  // Authoritative full history, updated synchronously on every line — used
  // for the log tail handed to onDone, independent of how the *rendered*
  // copy below is batched.
  const logsRef = useRef([]);
  // Lines received since the last flush into React state.
  const pendingLogsRef = useRef([]);
  const flushTimerRef = useRef(null);

  useEffect(() => {
    if (!job.id) return undefined;

    // A rebuild reuses this same job.id but starts a fresh attempt —
    // reset every per-attempt piece of local state so old logs/progress
    // from a previous try don't linger under the new one.
    setLogs([]);
    setStage('validating');
    setBuildStep(null);
    setBuildProgress(0);
    setCacheHit(false);
    setPaused(false);
    setExitCode(null);
    setControlMessage(null);
    doneFired.current = false;
    logsRef.current = [];
    pendingLogsRef.current = [];

    const flushLogs = () => {
      flushTimerRef.current = null;
      if (pendingLogsRef.current.length === 0) return;
      const batch = pendingLogsRef.current;
      pendingLogsRef.current = [];
      setLogs((prev) => prev.concat(batch));
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushLogs, LOG_FLUSH_MS);
      }
    };

    const stop = streamLogs(job.id, {
      onLog: (line) => {
        logsRef.current.push(line);
        pendingLogsRef.current.push(line);
        scheduleFlush();
      },
      onNotice: (payload) =>
        onNotice({ ...payload, title: payload.title ? `${job.fileName} — ${payload.title}` : job.fileName }),
      onStatus: ({ status, error, exitCode: code }) => {
        onUpdate(job.tempId, { status, error: error ?? null });
        setExitCode(code ?? null);
        if (status !== 'success' && status !== 'failed' && status !== 'stopped') setStage(status);
        if (status !== 'building') setPaused(false);
      },
      onQueue: ({ position }) => onUpdate(job.tempId, { queuePosition: position }),
      onStep: ({ step, progress, cacheHit: hit }) => {
        setBuildStep(step);
        setBuildProgress(progress || 0);
        if (hit) setCacheHit(true);
      },
      onPaused: ({ paused: p }) => setPaused(!!p),
      onDone: ({ status, error, exitCode: code }) => {
        // Flush any lines still sitting in the batch buffer immediately, so
        // an open log panel is fully caught up by the moment the build is
        // reported finished rather than waiting for the next timer tick.
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
        }
        flushLogs();
        setPaused(false);
        setExitCode(code ?? null);
        onUpdate(job.tempId, { status, error: error || null, downloadReady: status === 'success' });
        // Only advance the stepper on success. On failure/stop, leave
        // `stage` as whatever the last onStatus already set it to —
        // that's the stage the build actually ended at. (Setting it here
        // from this closure would use a stale value: this effect only
        // depends on job.id/buildKey, so it never re-runs to pick up
        // later `stage` updates.)
        if (status === 'success') setStage('success');
        if (!doneFired.current) {
          doneFired.current = true;
          onDone(job.tempId, job.id, job.fileName, status, error, logsRef.current, code ?? null, job.projectType);
        }
      },
    });

    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      stop();
    };
    // job.fileName/job.tempId/onNotice/onUpdate/onDone are stable enough
    // for this subscription's lifetime — only the id transitioning from
    // null to a real value, or a rebuild bumping buildKey, should re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, buildKey]);

  const isTerminal = job.status === 'success' || job.status === 'failed' || job.status === 'stopped';
  const isRunning = job.status === 'building';
  const canControl = job.id && isRunning;

  const runControl = useCallback(
    async (action, label) => {
      if (controlBusy) return;
      setControlBusy(true);
      setControlMessage(null);
      try {
        const result = await action();
        if (result && result.ok === false) {
          setControlMessage(result.message || `Could not ${label}.`);
        }
      } catch (err) {
        setControlMessage(err.message || `Could not ${label}.`);
      } finally {
        setControlBusy(false);
      }
    },
    [controlBusy]
  );

  const handlePause = () => runControl(() => pauseBuild(job.id), 'pause');
  const handleResume = () => runControl(() => resumeBuild(job.id), 'resume');
  const handleCancel = () => runControl(() => cancelBuild(job.id), 'stop');
  const handleRebuild = () => runControl(async () => {
    const result = await rebuildJob(job.id);
    onUpdate(job.tempId, { status: 'queued', error: null, downloadReady: false });
    setBuildKey((k) => k + 1);
    return result;
  }, 'rebuild');

  // Built locally from this ticket's own state rather than threaded down
  // from App.jsx's global errorContext — a ticket already has everything
  // (id, error, exit code, log tail) needed to drive both the file-path
  // guessing and the AI chat for *its own* failure, so the full-page
  // editor works the same whether this is the ticket App.jsx currently has
  // its global side panel pointed at or not.
  const localErrorContext = job.status === 'failed' || job.status === 'stopped'
    ? {
        jobId: job.id,
        fileName: job.fileName,
        projectType: job.projectType,
        errorMessage: job.error,
        logTail: logsRef.current.slice(-60),
        exitCode,
      }
    : null;

  return (
    <article className={`ticket ticket-${job.status}${paused ? ' ticket-paused' : ''}`}>
      <div className="ticket-stub" aria-hidden="true">
        <StatusGlyph status={job.status} paused={paused} />
      </div>

      <div className="ticket-body">
        <div className="ticket-head">
          <div className="ticket-name" title={job.fileName}>{job.fileName}</div>
          <div className="ticket-head-right">
            {job.fileSize > 0 && (
              <span className="ticket-size">{(job.fileSize / 1024 / 1024).toFixed(1)} MB</span>
            )}
            {isTerminal && (
              <button className="ticket-dismiss" onClick={() => onRemove(job.tempId)}>
                Dismiss
              </button>
            )}
          </div>
        </div>

        <Pipeline
          activeStage={stage}
          failed={job.status === 'failed'}
          stopped={job.status === 'stopped'}
          paused={paused}
          queuePosition={job.queuePosition}
          buildStep={buildStep}
          buildProgress={buildProgress}
          cacheHit={cacheHit}
        />

        {(canControl || job.status === 'failed' || job.status === 'stopped') && (
          <div className="build-controls">
            {canControl && !paused && (
              <button type="button" className="control-btn" onClick={handlePause} disabled={controlBusy}>
                ⏸ Pause
              </button>
            )}
            {canControl && paused && (
              <button type="button" className="control-btn control-btn-resume" onClick={handleResume} disabled={controlBusy}>
                ▶ Resume
              </button>
            )}
            {canControl && (
              <button type="button" className="control-btn control-btn-stop" onClick={handleCancel} disabled={controlBusy}>
                ■ Stop
              </button>
            )}
            {(job.status === 'failed' || job.status === 'stopped') && (
              <button type="button" className="control-btn control-btn-edit" onClick={() => setEditorMode('edit')} disabled={controlBusy}>
                ✎ Edit
              </button>
            )}
            {(job.status === 'failed' || job.status === 'stopped') && (
              <button type="button" className="control-btn control-btn-rebuild" onClick={handleRebuild} disabled={controlBusy}>
                ↻ Retry
              </button>
            )}
            {(job.status === 'failed' || job.status === 'stopped') && (
              <button type="button" className="control-btn control-btn-ai" onClick={() => setEditorMode('ai')} disabled={controlBusy}>
                ✦ AI
              </button>
            )}
            {controlMessage && <span className="control-message">{controlMessage}</span>}
          </div>
        )}

        {job.file && <FileTree file={job.file} />}

        <ErrorBanner
          message={job.status === 'failed' ? job.error : ''}
          exitCode={job.status === 'failed' ? exitCode : null}
        />
        {job.status === 'stopped' && <div className="stopped-box">Build stopped. Edit files below if needed, then Rebuild.</div>}

        {job.status === 'success' && <DownloadCard jobId={job.id} filename={job.fileName} />}

        {logs.length > 0 && (
          <div className="ticket-logs">
            <button className="log-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
              <span className={`log-toggle-caret${expanded ? ' open' : ''}`} aria-hidden="true">▸</span>
              {expanded ? 'Hide build log' : 'Show build log'}
            </button>
            {expanded && <LogPanel lines={logs} live={!isTerminal} />}
          </div>
        )}

        {job.id && (job.status === 'failed' || job.status === 'stopped' || job.status === 'success' || paused) && (
          <div className="ticket-files">
            <button className="log-toggle" onClick={() => setFilesOpen((e) => !e)} aria-expanded={filesOpen}>
              <span className={`log-toggle-caret${filesOpen ? ' open' : ''}`} aria-hidden="true">▸</span>
              {filesOpen ? 'Hide project files' : 'Edit project files'}
            </button>
            {filesOpen && (
              <ProjectExplorer jobId={job.id} readOnly={isRunning && !paused} />
            )}
          </div>
        )}
      </div>

      {editorMode && (
        <ProjectEditorModal
          job={job}
          mode={editorMode}
          errorContext={localErrorContext}
          readOnly={isRunning && !paused}
          onClose={() => setEditorMode(null)}
        />
      )}
    </article>
  );
}

// job/onUpdate/onDone/onNotice/onRemove are all stable per-tempId
// references now (see Dashboard in App.jsx), so this memo actually skips
// re-rendering — and re-running child renders (Pipeline, FileTree, etc.)
// for every OTHER ticket whenever just one job's status/logs change.
export default memo(JobTicket);

function StatusGlyph({ status, paused }) {
  if (paused) return <span className="glyph glyph-paused">⏸</span>;
  if (status === 'success') return <span className="glyph glyph-success">✓</span>;
  if (status === 'failed') return <span className="glyph glyph-failed">!</span>;
  if (status === 'stopped') return <span className="glyph glyph-stopped">■</span>;
  if (status === 'building') return <span className="glyph glyph-building" />;
  return <span className="glyph glyph-queued" />;
}
