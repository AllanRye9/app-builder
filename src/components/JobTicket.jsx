import { useEffect, useRef, useState } from 'react';
import Pipeline from './Pipeline.jsx';
import DownloadCard from './DownloadCard.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import { pollStatus } from '../api.js';

export default function JobTicket({ job, onUpdate, onDone, onRemove }) {
  const doneFired = useRef(false);

  useEffect(() => {
    if (!job.id) return undefined;

    const stop = pollStatus(job.id, {
      onUpdate: (data) => {
        onUpdate({
          status: data.status,
          error: data.error || null,
          apkUrl: data.apkUrl || null,
          runUrl: data.runUrl || job.runUrl || null,
        });
      },
      onDone: (data) => {
        if (!doneFired.current) {
          doneFired.current = true;
          onDone(data.status, data.error);
        }
      },
    });

    return stop;
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

        <Pipeline activeStage={job.status} failed={job.status === 'failed'} />

        <ErrorBanner message={job.status === 'failed' ? job.error : ''} />

        {job.status === 'success' && job.apkUrl && (
          <DownloadCard apkUrl={job.apkUrl} filename={job.fileName} />
        )}

        {job.runUrl && (
          <a className="log-toggle" href={job.runUrl} target="_blank" rel="noreferrer">
            <span aria-hidden="true">↗</span> View full build log on GitHub
          </a>
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
