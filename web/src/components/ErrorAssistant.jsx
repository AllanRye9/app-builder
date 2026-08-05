import { useState } from 'react';
import { askAssistant } from '../api.js';

// This panel exists only when there's something to react to — a failed
// build or a rejected upload (see App.jsx's errorContext state). There's
// no persistent "help" tab; the moment the error is dismissed, this whole
// side panel disappears rather than sitting there empty.
export default function ErrorAssistant({ errorContext, onDismiss }) {
  const [history, setHistory] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  if (!errorContext) return null;

  async function send(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    setBusy(true);
    const nextHistory = [...history, { role: 'user', content: q }];
    setHistory(nextHistory);
    try {
      const { answer, source } = await askAssistant(q, errorContext, history);
      setHistory([...nextHistory, { role: 'assistant', content: answer, source }]);
    } catch (err) {
      setHistory([
        ...nextHistory,
        { role: 'assistant', content: `Couldn't reach the assistant: ${err.message}`, source: 'error' },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="side-panel side-panel-right hide-scrollbar" aria-label="Build error help">
      <div className="side-panel-section">
        <div className="side-panel-title-row">
          <div className="side-panel-title assist-title">
            <span className="assist-dot" aria-hidden="true" />
            Need a hand?
          </div>
          <button type="button" className="assist-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
        </div>

        <div className="assist-context">
          <div className="assist-context-file" title={errorContext.fileName}>{errorContext.fileName}</div>
          <div className="assist-context-error">{errorContext.errorMessage}</div>
        </div>

        <div className="assist-thread hide-scrollbar">
          {history.length === 0 && (
            <div className="assist-empty">
              Ask about this error — what caused it, and how to fix it. Answered using AI if this
              instance has a key configured, otherwise from built-in troubleshooting knowledge.
            </div>
          )}
          {history.map((turn, i) => (
            <div key={i} className={`assist-msg assist-msg-${turn.role}`}>
              {turn.role === 'assistant' && turn.source === 'fallback' && (
                <div className="assist-source-tag">built-in knowledge</div>
              )}
              {turn.content}
            </div>
          ))}
          {busy && (
            <div className="assist-msg assist-msg-assistant assist-typing">
              Thinking
              <span className="assist-typing-dots"><span /><span /><span /></span>
            </div>
          )}
        </div>

        <form className="assist-form" onSubmit={send}>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this error…"
            aria-label="Ask about this error"
          />
          <button type="submit" disabled={busy || !question.trim()} aria-label="Send">
            <IconSend />
          </button>
        </form>
      </div>
    </aside>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M17 3 3 9.5l6 2.3M17 3l-5.5 14-2.5-5.2M17 3 9.5 11.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
