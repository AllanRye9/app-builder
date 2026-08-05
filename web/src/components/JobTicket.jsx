import { memo, useEffect, useRef, useState } from 'react';
import Pipeline from './Pipeline.jsx';
import LogPanel from './LogPanel.jsx';
import DownloadCard from './DownloadCard.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import FileTree from './FileTree.jsx';
import { streamLogs } from '../api.js';

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
  const [buildStep, setBuildStep] = useState(null);
  const [buildProgress, setBuildProgress] = useState(0);
  const [cacheHit, setCacheHit] = useState(false);
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
      onStatus: ({ status, error }) => {
        onUpdate(job.tempId, { status, error: error ?? null });
        if (status !== 'success' && status !== 'failed') setStage(status);
      },
      onQueue: ({ position }) => onUpdate(job.tempId, { queuePosition: position }),
      onStep: ({ step, progress, cacheHit: hit }) => {
        setBuildStep(step);
        setBuildProgress(progress || 0);
        if (hit) setCacheHit(true);
      },
      onDone: ({ status, error }) => {
        // Flush any lines still sitting in the batch buffer immediately, so
        // an open log panel is fully caught up by the moment the build is
        // reported finished rather than waiting for the next timer tick.
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
        }
        flushLogs();
        onUpdate(job.tempId, { status, error: error || null, downloadReady: status === 'success' });
        // Only advance the stepper on success. On failure, leave `stage` as
        // whatever the last onStatus already set it to — that's the stage
        // the build actually failed at. (Setting it here from this closure
        // would use a stale value: this effect only depends on job.id, so
        // it never re-runs to pick up later `stage` updates.)
        if (status === 'success') setStage('success');
        if (!doneFired.current) {
          doneFired.current = true;
          onDone(job.tempId, job.fileName, status, error, logsRef.current);
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
    // null to a real value should re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  const isTerminal = job.status === 'success' || job.status === 'failed';

  return (
    <article className={`ticket ticket-${job.status}`}>
      <div className="ticket-stub" aria-hidden="true">
        <StatusGlyph status={job.status} />
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
          queuePosition={job.queuePosition}
          buildStep={buildStep}
          buildProgress={buildProgress}
          cacheHit={cacheHit}
        />

        {job.file && <FileTree file={job.file} />}

        <ErrorBanner message={job.status === 'failed' ? job.error : ''} />

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
      </div>
    </article>
  );
}

// job/onUpdate/onDone/onNotice/onRemove are all stable per-tempId
// references now (see Dashboard in App.jsx), so this memo actually skips
// re-rendering — and re-running child renders (Pipeline, FileTree, etc.)
// for every OTHER ticket whenever just one job's status/logs change.
export default memo(JobTicket);

function StatusGlyph({ status }) {
  if (status === 'success') return <span className="glyph glyph-success">✓</span>;
  if (status === 'failed') return <span className="glyph glyph-failed">!</span>;
  if (status === 'building') return <span className="glyph glyph-building" />;
  return <span className="glyph glyph-queued" />;
}
