import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchProjectFiles, askAssistant } from '../api.js';
import { guessCandidatePaths, isPathImplicated } from '../lib/errorPaths.js';
import FileEditorPopup from './FileEditorPopup.jsx';
import LogPanel from './LogPanel.jsx';

// Full-page project browser opened from a failed/stopped build ticket via
// its "Edit" or "AI" button (see JobTicket.jsx). Unlike the small inline
// ProjectExplorer panel, this shows the *entire* directory at once with
// files the error text/log implicates marked in red, and — in 'ai' mode —
// a live chat with the Claude-backed assistant (see app/assist.py) docked
// alongside it so a fix can be discussed and applied without losing the
// tree.
export default function ProjectEditorModal({ job, mode, errorContext, readOnly, onClose }) {
  const [tree, setTree] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [expandedDirs, setExpandedDirs] = useState(() => new Set());
  const [openPath, setOpenPath] = useState(null);

  const [history, setHistory] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  // The build log tail is shown right here, at the site of the edit, so
  // the failure context stays visible while browsing/fixing files instead
  // of requiring the person to close this modal to see it on the ticket
  // behind it. Open by default since that's the point of showing it here;
  // minimizable for anyone who'd rather have the extra room.
  const [logOpen, setLogOpen] = useState(true);

  const candidatePaths = useMemo(() => guessCandidatePaths(errorContext), [errorContext]);
  const logLines = errorContext?.logTail || [];

  const reload = useCallback(() => {
    if (!job.id) return;
    fetchProjectFiles(job.id)
      .then((r) => {
        setTree(r.tree || []);
        setTruncated(!!r.truncated);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err.message));
  }, [job.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-expand every ancestor directory of a guessed-implicated file, so
  // the red markup is visible the moment the tree loads rather than
  // requiring a manual click-through to discover it.
  useEffect(() => {
    if (!tree || candidatePaths.length === 0) return;
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const path of candidatePaths) {
        const parts = path.split('/');
        let acc = '';
        for (let i = 0; i < parts.length - 1; i += 1) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          next.add(acc);
        }
      }
      return next;
    });
  }, [tree, candidatePaths]);

  function toggleDir(path) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleEditorClosed(savedPath) {
    setOpenPath(null);
    if (savedPath) reload();
  }

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
    <div className="modal-overlay project-editor-overlay" onClick={onClose}>
      <div
        className="modal-panel modal-panel-xl project-editor-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${mode === 'ai' ? 'AI-assisted' : 'Manual'} edit — ${job.fileName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{mode === 'ai' ? 'AI-assisted fix' : 'Edit project'} — {job.fileName}</h2>
            {errorContext?.errorMessage && (
              <div className="project-editor-error-summary" title={errorContext.errorMessage}>
                {errorContext.errorMessage}
                {errorContext.exitCode != null && <span className="assist-exit-code"> (exit code {errorContext.exitCode})</span>}
              </div>
            )}
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        {logLines.length > 0 && (
          <div className="project-editor-logs">
            <button
              type="button"
              className="log-toggle project-editor-log-toggle"
              onClick={() => setLogOpen((o) => !o)}
              aria-expanded={logOpen}
            >
              <span className={`log-toggle-caret${logOpen ? ' open' : ''}`} aria-hidden="true">▸</span>
              {logOpen ? 'Hide build log' : 'Show build log'}
            </button>
            {logOpen && <LogPanel lines={logLines} live={false} />}
          </div>
        )}

        <div className={`project-editor-body${mode === 'ai' ? ' project-editor-body-split' : ''}`}>
          <div className="project-editor-tree-col">
            {candidatePaths.length > 0 && (
              <div className="project-editor-hint">
                <span className="project-editor-hint-dot" aria-hidden="true" />
                Files in red are likely involved in the failure — click one to open it.
              </div>
            )}
            {loadError && <div className="pfe-error">{loadError}</div>}
            <div className="pfe-tree project-editor-tree hide-scrollbar">
              {tree === null && !loadError && <div className="pfe-empty">Loading…</div>}
              {tree && tree.length === 0 && <div className="pfe-empty">No project files available.</div>}
              {tree && tree.map((node) => (
                <EditorTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedDirs={expandedDirs}
                  onToggleDir={toggleDir}
                  onOpenFile={setOpenPath}
                  candidatePaths={candidatePaths}
                />
              ))}
            </div>
            {truncated && <div className="pfe-truncated">Showing a partial listing — this project has more files than fit here.</div>}
          </div>

          {mode === 'ai' && (
            <div className="project-editor-chat-col">
              <div className="assist-thread hide-scrollbar">
                {history.length === 0 && (
                  <div className="assist-empty">
                    Ask about this error, or click a red file on the left to fix it directly. Answered
                    using AI if this instance has a key configured, otherwise from built-in
                    troubleshooting knowledge.
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
                <button type="submit" disabled={busy || !question.trim()}>Send</button>
              </form>
            </div>
          )}
        </div>
      </div>

      {openPath && (
        <FileEditorPopup
          jobId={job.id}
          path={openPath}
          readOnly={!!readOnly}
          onClose={handleEditorClosed}
        />
      )}
    </div>
  );
}

function EditorTreeNode({ node, depth, expandedDirs, onToggleDir, onOpenFile, candidatePaths }) {
  const isDir = node.type === 'dir';
  const expanded = isDir && expandedDirs.has(node.path);
  const implicated = !isDir && isPathImplicated(node.path, candidatePaths);
  // A folder gets a small warning dot (not full red text) if something
  // inside it is implicated — keeps the highlight legible even collapsed,
  // without painting an entire subtree red for one file.
  const containsImplicated =
    isDir && candidatePaths.some((p) => p === node.path || p.startsWith(`${node.path}/`));

  return (
    <div className="pfe-node" style={{ '--depth': depth }}>
      <div className={`pfe-row pfe-row-${node.type}${implicated ? ' pfe-row-implicated' : ''}`}>
        <button
          type="button"
          className="pfe-row-main"
          onClick={() => (isDir ? onToggleDir(node.path) : onOpenFile(node.path))}
        >
          <span className={`pfe-caret${isDir ? '' : ' pfe-caret-hidden'}${expanded ? ' open' : ''}`} aria-hidden="true">▸</span>
          <span className="pfe-name">{node.name}{isDir ? '/' : ''}</span>
          {containsImplicated && !expanded && <span className="pfe-implicated-dot" title="Contains a file likely involved in the failure" />}
          {node.skipped && <span className="pfe-skip-tag">not shown</span>}
        </button>
      </div>

      {isDir && expanded && !node.skipped && node.children && (
        <div className="pfe-children">
          {node.children.length === 0 && <div className="pfe-empty-dir" style={{ '--depth': depth + 1 }}>empty</div>}
          {node.children.map((child) => (
            <EditorTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              candidatePaths={candidatePaths}
            />
          ))}
        </div>
      )}
    </div>
  );
}
