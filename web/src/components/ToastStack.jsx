import { useEffect } from 'react';

const AUTO_DISMISS_MS = 9000;

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
  useEffect(() => {
    if (notice.level === 'error') return undefined; // let errors stick around
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [notice.level, onDismiss]);

  return (
    <div className={`toast toast-${notice.level}`} role="status">
      <div className="toast-body">
        <div className="toast-title">{notice.title}</div>
        <div className="toast-message">{notice.message}</div>
      </div>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
