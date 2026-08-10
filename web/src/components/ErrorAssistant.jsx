import { useEffect, useMemo, useState } from 'react';
import { askAssistant, fetchProjectFileContent, saveProjectFileContent } from '../api.js';

// Regex-guessed file-path-looking tokens pulled out of the error text/log
// tail, so the quick-fix editor can offer one-click chips instead of
// making the person hunt for and retype the exact path themselves. Purely
// a convenience — a manual path field covers anything this misses. The
// leading `\/?` is deliberate: without it, an absolute path like
// "/home/build/.../Foo.kt" would match starting at "home", losing the
// leading slash before toProjectRelative() below ever gets a chance to
// recognize it as absolute.
const PATH_PATTERN = /\/?[\w][\w.\-/]*\.(?:kt|kts|java|xml|gradle|json|dart|ya?ml|properties|pro|cfg|jsx?|tsx?)\b/g;

// Known top-level source directories across the project types this app
// builds (Capacitor/web, native Android, Flutter). A build tool's own
// error output often reports an *absolute* container path (e.g.
// "/home/build/jobs/<id>/project/app/src/main/kotlin/Foo.kt") rather than
// one relative to the project root the file-editor API expects. The
// frontend has no way to know the server's absolute jobs-root prefix
// (it's configurable per deployment — see config.py's JOB_ROOT), so the
// only safe move for an absolute-looking path is to look for one of these
// familiar directory names appearing *later* in the path and keep only
// from there onward. Applied only to paths already identified as
// absolute — never to an already-relative match — so a normal relative
// mention like "app/src/main/...Kt" is trusted as-is rather than risking
// an over-eager cut at its own first "src/" segment.
const PROJECT_ROOT_MARKERS = ['app/', 'src/', 'lib/', 'android/', 'ios/', 'assets/', 'test/'];

function toProjectRelative(rawPath) {
  const cleaned = rawPath.replace(/^\.\/+/, '');
  if (!cleaned.startsWith('/')) {
    return cleaned; // already relative-looking — trust it as-is
  }
  for (const marker of PROJECT_ROOT_MARKERS) {
    const idx = cleaned.lastIndexOf(`/${marker}`);
    if (idx !== -1) return cleaned.slice(idx + 1);
  }
  // No recognizable project-relative anchor in this absolute path — don't
  // guess wrong; a bad chip that 404s is worse than one fewer chip.
  return null;
}

function guessCandidatePaths(errorContext) {
  const haystack = [errorContext.errorMessage, ...(errorContext.logTail || [])].join('\n');
  const found = haystack.match(PATH_PATTERN) || [];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    if (raw.startsWith('http') || raw.startsWith('//')) continue;
    const path = toProjectRelative(raw);
    if (!path || path.length > 140 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= 6) break;
  }
  return out;
}

// This panel exists only when there's something to react to — a failed
// build or a rejected upload (see App.jsx's errorContext state). There's
// no persistent "help" tab; the moment the error is dismissed, this whole
// side panel disappears rather than sitting there empty.
export default function ErrorAssistant({ errorContext, onDismiss }) {
  const [history, setHistory] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  // Quick-fix editor state — writes directly to the file that (likely)
  // caused the failure, for small corrections, without leaving this panel.
  const [quickFixOpen, setQuickFixOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [activePath, setActivePath] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [fileState, setFileState] = useState('idle'); // idle | loading | ready | saving | saved | error
  const [fileError, setFileError] = useState(null);

  const candidatePaths = useMemo(
    () => (errorContext ? guessCandidatePaths(errorContext) : []),
    [errorContext]
  );

  // A fresh error means a fresh editor — don't carry a previous failure's
  // open file into this one's panel.
  useEffect(() => {
    setQuickFixOpen(false);
    setActivePath(null);
    setContent('');
    setSavedContent('');
    setFileState('idle');
    setFileError(null);
    setManualPath('');
  }, [errorContext?.jobId, errorContext?.fileName]);

  if (!errorContext) return null;

  const canQuickFix = Boolean(errorContext.jobId);

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

  function openQuickFixFile(path) {
    if (!path || !path.trim()) return;
    const trimmed = path.trim();
    setActivePath(trimmed);
    setFileState('loading');
    setFileError(null);
    fetchProjectFileContent(errorContext.jobId, trimmed)
      .then((r) => {
        setContent(r.content);
        setSavedContent(r.content);
        setFileState('ready');
      })
      .catch((err) => {
        setFileError(err.message);
        setFileState('error');
      });
  }

  async function saveQuickFix() {
    if (!activePath) return;
    setFileState('saving');
    try {
      await saveProjectFileContent(errorContext.jobId, activePath, content);
      setSavedContent(content);
      setFileState('saved');
    } catch (err) {
      setFileError(err.message);
      setFileState('error');
    }
  }

  const dirty = (fileState === 'ready' || fileState === 'saved') && content !== savedContent;

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
          <div className="assist-context-error">
            {errorContext.errorMessage}
            {errorContext.exitCode != null && (
              <span className="assist-exit-code"> (exit code {errorContext.exitCode})</span>
            )}
          </div>
        </div>

        {canQuickFix && (
          <div className="quickfix">
            <button
              type="button"
              className="quickfix-toggle"
              onClick={() => setQuickFixOpen((o) => !o)}
              aria-expanded={quickFixOpen}
            >
              <span className={`log-toggle-caret${quickFixOpen ? ' open' : ''}`} aria-hidden="true">▸</span>
              Quick fix — edit a file directly
            </button>

            {quickFixOpen && (
              <div className="quickfix-body">
                <div className="quickfix-hint">
                  For small, targeted corrections (a config value, a missing permission, a typo) —
                  not a substitute for reviewing the full log.
                </div>

                {candidatePaths.length > 0 && (
                  <div className="quickfix-chips">
                    {candidatePaths.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`quickfix-chip${activePath === p ? ' active' : ''}`}
                        onClick={() => openQuickFixFile(p)}
                        title={p}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}

                <form
                  className="quickfix-path-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    openQuickFixFile(manualPath);
                  }}
                >
                  <input
                    type="text"
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                    placeholder="path/in/project, e.g. app/src/main/AndroidManifest.xml"
                  />
                  <button type="submit">Open</button>
                </form>

                {fileState === 'loading' && <div className="quickfix-status">Loading…</div>}
                {fileState === 'error' && <div className="quickfix-status quickfix-error">{fileError}</div>}

                {(fileState === 'ready' || fileState === 'saving' || fileState === 'saved') && (
                  <>
                    <div className="quickfix-editor-path" title={activePath}>{activePath}</div>
                    <textarea
                      className="quickfix-textarea"
                      value={content}
                      onChange={(e) => {
                        setContent(e.target.value);
                        if (fileState === 'saved') setFileState('ready');
                      }}
                      spellCheck={false}
                    />
                    <div className="quickfix-actions">
                      <button
                        type="button"
                        className="quickfix-save-btn"
                        onClick={saveQuickFix}
                        disabled={fileState === 'saving' || !dirty}
                      >
                        {fileState === 'saving' ? 'Saving…' : 'Save fix'}
                      </button>
                      {fileState === 'saved' && (
                        <span className="quickfix-saved-note">Saved — hit Rebuild on the job below to try again.</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

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
