export default function ToastStack({ notices, onDismiss }) {
  if (notices.length === 0) return null;

  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {notices.map((n) => (
        <div key={n.id} className={`toast toast-${n.level || 'info'}`} role="status">
          <div className="toast-body">
            {n.title && <div className="toast-title">{n.title}</div>}
            {n.message && <div className="toast-message">{n.message}</div>}
          </div>
          <button className="toast-close" onClick={() => onDismiss(n.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
