import { useEffect, useRef } from 'react';

// Only ever mounted while App.jsx has an "active error job" — i.e. only
// once something has actually failed. Not a general-purpose chat widget:
// every question is scoped server-side to one specific job's error/log
// context (see POST /api/assist in app/routes.py), so this is a debugging
// aid for *this* failure, not an open-ended assistant.
export default function ErrorAssistPanel({ job, messages, input, onInputChange, onSend, busy, onClose }) {
  const threadRef = useRef(null);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, busy]);

  return (
    <div className="assist-panel">
      <div className="side-panel-title-row">
        <div className="side-panel-title">AI build assistant</div>
        <button type="button" className="assist-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <p className="assist-context">
        About the failure in <strong>{job.fileName}</strong>
        {job.error ? <>: <span className="assist-context-error">{job.error}</span></> : null}
      </p>

      <div className="assist-thread hide-scrollbar" ref={threadRef}>
        {messages.length === 0 && (
          <p className="assist-empty">
            Ask about this error — e.g. “why did this fail?” or “how do I fix it?”
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`assist-msg assist-msg-${m.role}`}>
            {m.role === 'assistant' && m.aiAvailable === false && (
              <div className="assist-fallback-tag">no AI configured — plain answer</div>
            )}
            <p>{m.text}</p>
          </div>
        ))}
        {busy && (
          <div className="assist-msg assist-msg-assistant assist-typing">
            <span /><span /><span />
          </div>
        )}
      </div>

      <form
        className="assist-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Ask about this error…"
          disabled={busy}
          maxLength={800}
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 12h15m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}
