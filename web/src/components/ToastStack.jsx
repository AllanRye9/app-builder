import { useEffect, useRef, useState } from 'react';

const AUTO_DISMISS_MS = 9000;
// Error toasts stay up longer than the rest — enough time to actually read
// a build-failure message — but still leave on their own eventually rather
// than sitting there forever; the person can still close them early.
const AUTO_DISMISS_ERROR_MS = 20000;
// Must match the toast-out animation's duration in index.css — the row is
// only actually removed from state once the leave animation has had time
// to finish playing, so it slides/fades out instead of just vanishing.
const LEAVE_ANIMATION_MS = 220;

export default function ToastStack({ notices, onDismiss }) {
  if (notices.length === 0) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Build notifications">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} onDismiss={() => onDismiss(n.id)} />
      ))}
    </div>
  );
}

function Toast({ notice, onDismiss }) {
  // 'entering' | 'idle' | 'leaving' — drives which animation class is
  // applied; the toast is only unmounted (via onDismiss) once 'leaving'
  // has had time to actually play out.
  const [phase, setPhase] = useState('idle');
  const leaveTimerRef = useRef(null);

  const startLeaving = () => {
    if (leaveTimerRef.current !== null) return; // already leaving
    setPhase('leaving');
    leaveTimerRef.current = setTimeout(onDismiss, LEAVE_ANIMATION_MS);
  };

  useEffect(() => {
    const autoMs = notice.level === 'error' ? AUTO_DISMISS_ERROR_MS : AUTO_DISMISS_MS;
    const t = setTimeout(startLeaving, autoMs);
    return () => {
      clearTimeout(t);
      if (leaveTimerRef.current !== null) clearTimeout(leaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice.level]);

  return (
    <div
      className={`toast toast-${notice.level}${phase === 'leaving' ? ' toast-leaving' : ''}`}
      role="status"
    >
      <div className="toast-body">
        <div className="toast-title">{notice.title}</div>
        <div className="toast-message">{notice.message}</div>
      </div>
      <button className="toast-close" onClick={startLeaving} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
