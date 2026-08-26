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

export default function LogPanel({ lines, live }) {
  const ref = useRef(null);

  // One element per line (rather than joining into a single text blob) is
  // what lets each line carry its own error styling. Still memoized on
  // `lines` alone — it's O(n) in total log size, run on every
  // keystroke-speed SSE update while the panel is open — so it only
  // re-runs when `lines` itself actually changes, not on renders caused by
  // unrelated state (e.g. `live` toggling at build completion).
  const rendered = useMemo(
    () =>
      lines.map((line, i) => (
        <div key={i} className={ERROR_LINE_RE.test(line) ? 'log-line log-line-error' : 'log-line'}>
          {line}
        </div>
      )),
    [lines]
  );

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div className="log-panel" ref={ref}>
      {rendered}
      {live && <span className="cursor" />}
    </div>
  );
}
