import { useEffect, useMemo, useRef } from 'react';

export default function LogPanel({ lines, live }) {
  const ref = useRef(null);

  // join() over a build's full log is the most expensive part of rendering
  // this panel (it's O(n) in total log size, run on every keystroke-speed
  // SSE update while the panel is open). Memoizing means it only re-runs
  // when `lines` itself actually changes, not on renders caused by
  // unrelated state (e.g. `live` toggling at build completion).
  const text = useMemo(() => lines.join('\n'), [lines]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div className="log-panel" ref={ref}>
      {text}
      {live && <span className="cursor" />}
    </div>
  );
}
