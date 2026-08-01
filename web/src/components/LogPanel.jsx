import { useEffect, useRef } from 'react';

export default function LogPanel({ lines, live }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <div className="log-panel" ref={ref}>
      {lines.join('\n')}
      {live && <span className="cursor" />}
    </div>
  );
}
