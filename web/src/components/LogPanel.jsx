import { useEffect, useMemo, useRef } from 'react';

// A line matching this is flagged red so a failure is easy to spot while
// scanning a long log instead of having to read every line. Deliberately
// broad (errors, exceptions, fatal/failed states, stack traces, npm's
// "ERR!" marker, and kotlinc's terse "e: " prefix) and substring-based
// rather than \b-word-bounded — build tools routinely fold these into
// compound identifiers (RuntimeException, IOException, "2 errors") that
// \b would miss entirely. A false positive just colors an unremarkable
// line, which costs nothing; a false negative would hide a real failure.
const ERROR_LINE_RE = /error|exception|fatal|fail|traceback|npm err|^\s*e:/i;

// A softer variant for lines worth a second glance but not a full error
// treatment — warnings, deprecations. Kept visually distinct (amber, not
// red) so an actual error never has to compete with noise for attention.
const WARN_LINE_RE = /warn|deprecat/i;

// Exported so other views (the ticket's inline log toggle, the editor's
// log dock) can show an error count without re-implementing the pattern.
export function countLogErrors(lines) {
  let n = 0;
  for (const line of lines) if (ERROR_LINE_RE.test(line)) n += 1;
  return n;
}

function classifyLine(line) {
  if (ERROR_LINE_RE.test(line)) return 'error';
  if (WARN_LINE_RE.test(line)) return 'warn';
  return '';
}

export default function LogPanel({ lines, live, title, showHeader = true }) {
  const ref = useRef(null);

  // One element per line (rather than joining into a single text blob) is
  // what lets each line carry its own error styling, and a stable line
  // number for scanning a long build. Still memoized on `lines` alone —
  // it's O(n) in total log size, run on every keystroke-speed SSE update
  // while the panel is open — so it only re-runs when `lines` itself
  // actually changes, not on renders caused by unrelated state (e.g.
  // `live` toggling at build completion).
  const { rendered, errorCount, warnCount } = useMemo(() => {
    let errors = 0;
    let warns = 0;
    const els = lines.map((line, i) => {
      const kind = classifyLine(line);
      if (kind === 'error') errors += 1;
      else if (kind === 'warn') warns += 1;
      return (
        <div key={i} className={kind ? `log-line log-line-${kind}` : 'log-line'}>
          <span className="log-line-no">{i + 1}</span>
          <span className="log-line-text">{line}</span>
        </div>
      );
    });
    return { rendered: els, errorCount: errors, warnCount: warns };
  }, [lines]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div className="log-panel-wrap">
      {showHeader && (
        <div className="log-panel-header">
          <span className="log-panel-title">{title || 'Build log'}</span>
          <span className="log-panel-stats">
            {live && <span className="log-panel-live"><span className="log-panel-live-dot" />live</span>}
            <span className="log-panel-count">{lines.length} lines</span>
            {warnCount > 0 && <span className="log-panel-badge log-panel-badge-warn">{warnCount} warn</span>}
            {errorCount > 0 && <span className="log-panel-badge log-panel-badge-error">{errorCount} error{errorCount === 1 ? '' : 's'}</span>}
          </span>
        </div>
      )}
      <div className="log-panel" ref={ref}>
        {rendered}
        {live && <span className="cursor" />}
      </div>
    </div>
  );
}
