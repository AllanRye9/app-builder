import { useEffect, useRef, useState } from 'react';
import Pipeline from './Pipeline.jsx';
import LogPanel from './LogPanel.jsx';
import DownloadCard from './DownloadCard.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import { streamLogs } from '../api.js';

// One ticket per build. Owns its own SSE subscription and log buffer — logs
// are only ever needed inside this card, so there's no reason to lift them
// into the parent's state and re-render the whole floor on every line.
// Only the small summary fields (status, error, queue position) are
// reported upward, for the stats bar and the toast/notification triggers.
export default function JobTicket({ job, onUpdate, onDone, onNotice, onRemove }) {
  const [logs, setLogs] = useState([]);
  const [stage, setStage] = useState('validating');
  const [expanded, setExpanded] = useState(false);
  const doneFired = useRef(false);

  useEffect(() => {
    if (!job.id) return undefined;

    const stop = streamLogs(job.id, {
      onLog: (line) => setLogs((prev) => [...prev, line]),
      onNotice: (payload) =>
        onNotice({ ...payload, title: payload.title ? `${job.fileName} — ${payload.title}` : job.fileName }),
      onStatus: ({ status, error }) => {
        onUpdate({ status, error: error ?? null });
        if (status !== 'success' && status !== 'failed') setStage(status);
      },
      onQueue: ({ position }) => onUpdate({ queuePosition: position }),
      onDone: ({ status, error }) => {
        onUpdate({ status, error: error || null, downloadReady: status === 'success' });
        // Only advance the stepper on success. On failure, leave `stage` as
        // whatever the last onStatus already set it to — that's the stage
        // the build actually failed at. (Setting it here from this closure
        // would use a stale value: this effect only depends on job.id, so
        // it never re-runs to pick up later `stage` updates.)
        if (status === 'success') setStage('success');
        if (!doneFired.current) {
          doneFired.current = true;
          onDone(status, error);
        }
      },
    });

    return stop;
    // job.fileName/onNotice/onUpdate/onDone are stable enough for this
    // subscription's lifetime — only the id transitioning from null to a
    // real value should re-run it.
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
              <button className="ticket-dismiss" onClick={onRemove}>
                Dismiss
              </button>
            )}
          </div>
        </div>

        <Pipeline activeStage={stage} failed={job.status === 'failed'} queuePosition={job.queuePosition} />

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

function StatusGlyph({ status }) {
  if (status === 'success') return <span className="glyph glyph-success">✓</span>;
  if (status === 'failed') return <span className="glyph glyph-failed">!</span>;
  if (status === 'building') return <span className="glyph glyph-building" />;
  return <span className="glyph glyph-queued" />;
}
