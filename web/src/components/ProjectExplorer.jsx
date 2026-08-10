import { useCallback, useEffect, useState } from 'react';
import {
  fetchProjectFiles,
  fetchProjectFileContent,
  saveProjectFileContent,
  createProjectFile,
  deleteProjectFile,
  renameProjectFile,
} from '../api.js';

// Server-backed browser/editor for the extracted project sitting in
// job.project_dir — lets an uploader make a small, targeted correction
// (a typo in a Gradle file, a missing manifest permission, a config
// value) and rebuild, without re-zipping and re-uploading the whole
// project. Deliberately not a full IDE: plain-text editing only, one file
// open at a time, size-limited server-side.
//
// `openPath`/`onOpenedPath` let a parent (the error assistant's quick-fix
// flow) drive this panel open to a specific file from outside.
export default function ProjectExplorer({ jobId, readOnly, openPath, onOpenedPath, onSaved }) {
  const [tree, setTree] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [expandedDirs, setExpandedDirs] = useState(() => new Set());
  const [activePath, setActivePath] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [fileState, setFileState] = useState('idle'); // idle | loading | ready | saving | error
  const [fileError, setFileError] = useState(null);
  const [pendingNew, setPendingNew] = useState(null); // { parentPath, isDir } while naming a new entry
  const [newName, setNewName] = useState('');

  const reload = useCallback(() => {
    if (!jobId) return;
    fetchProjectFiles(jobId)
      .then((r) => {
        setTree(r.tree || []);
        setTruncated(!!r.truncated);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err.message));
  }, [jobId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const openFile = useCallback(
    (path) => {
      setActivePath(path);
      setFileState('loading');
      setFileError(null);
      fetchProjectFileContent(jobId, path)
        .then((r) => {
          setContent(r.content);
          setSavedContent(r.content);
          setFileState('ready');
        })
        .catch((err) => {
          setFileError(err.message);
          setFileState('error');
        });
    },
    [jobId]
  );

  // Let an external trigger (the error assistant's "open in editor" chip)
  // drive this panel open to a specific file.
  useEffect(() => {
    if (openPath) {
      openFile(openPath);
      onOpenedPath?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath]);

  function toggleDir(path) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleSave() {
    if (!activePath || readOnly) return;
    setFileState('saving');
    try {
      await saveProjectFileContent(jobId, activePath, content);
      setSavedContent(content);
      setFileState('ready');
      onSaved?.(activePath);
    } catch (err) {
      setFileError(err.message);
      setFileState('error');
    }
  }

  async function handleDelete(path) {
    if (readOnly) return;
    if (!window.confirm(`Delete ${path}? This can't be undone.`)) return;
    try {
      await deleteProjectFile(jobId, path);
      if (activePath === path || activePath?.startsWith(`${path}/`)) {
        setActivePath(null);
        setContent('');
        setSavedContent('');
        setFileState('idle');
      }
      reload();
    } catch (err) {
      window.alert(`Could not delete ${path}: ${err.message}`);
    }
  }

  async function handleRename(path) {
    if (readOnly) return;
    const name = window.prompt('Rename to:', path.split('/').pop());
    if (!name || !name.trim()) return;
    const parts = path.split('/');
    parts[parts.length - 1] = name.trim();
    const nextPath = parts.join('/');
    try {
      await renameProjectFile(jobId, path, nextPath);
      if (activePath === path) setActivePath(nextPath);
      reload();
    } catch (err) {
      window.alert(`Could not rename ${path}: ${err.message}`);
    }
  }

  function startNew(parentPath, isDir) {
    setPendingNew({ parentPath, isDir });
    setNewName('');
  }

  async function confirmNew(e) {
    e.preventDefault();
    if (!pendingNew || !newName.trim()) return;
    const path = pendingNew.parentPath ? `${pendingNew.parentPath}/${newName.trim()}` : newName.trim();
    try {
      await createProjectFile(jobId, path, { isDir: pendingNew.isDir, content: '' });
      setPendingNew(null);
      setNewName('');
      reload();
      if (!pendingNew.isDir) openFile(path);
    } catch (err) {
      window.alert(`Could not create ${path}: ${err.message}`);
    }
  }

  const dirty = fileState === 'ready' && content !== savedContent;

  return (
    <div className="pfe">
      <div className="pfe-tree-col">
        <div className="pfe-tree-toolbar">
          <span className="pfe-tree-title">Project files</span>
          <button type="button" className="pfe-icon-btn" title="New file at root" onClick={() => startNew('', false)} disabled={readOnly}>
            + file
          </button>
          <button type="button" className="pfe-icon-btn" title="New folder at root" onClick={() => startNew('', true)} disabled={readOnly}>
            + folder
          </button>
        </div>

        {pendingNew && pendingNew.parentPath === '' && (
          <form className="pfe-new-form" onSubmit={confirmNew}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={pendingNew.isDir ? 'folder-name' : 'file-name.ext'}
            />
            <button type="submit">Add</button>
            <button type="button" onClick={() => setPendingNew(null)}>Cancel</button>
          </form>
        )}

        {loadError && <div className="pfe-error">{loadError}</div>}

        <div className="pfe-tree hide-scrollbar">
          {tree === null && !loadError && <div className="pfe-empty">Loading…</div>}
          {tree && tree.length === 0 && <div className="pfe-empty">No project files available.</div>}
          {tree && tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expandedDirs={expandedDirs}
              onToggleDir={toggleDir}
              activePath={activePath}
              onOpenFile={openFile}
              onDelete={handleDelete}
              onRename={handleRename}
              onNewChild={startNew}
              pendingNew={pendingNew}
              newName={newName}
              setNewName={setNewName}
              onConfirmNew={confirmNew}
              onCancelNew={() => setPendingNew(null)}
              readOnly={readOnly}
            />
          ))}
        </div>
        {truncated && <div className="pfe-truncated">Showing a partial listing — this project has more files than fit here.</div>}
      </div>

      <div className="pfe-editor-col">
        {!activePath && <div className="pfe-empty pfe-editor-empty">Select a file to view or edit it.</div>}
        {activePath && (
          <>
            <div className="pfe-editor-toolbar">
              <span className="pfe-editor-path" title={activePath}>{activePath}</span>
              {dirty && <span className="pfe-dirty-dot" title="Unsaved changes" />}
              {!readOnly && (
                <button
                  type="button"
                  className="pfe-save-btn"
                  onClick={handleSave}
                  disabled={fileState !== 'ready' || !dirty}
                >
                  {fileState === 'saving' ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            {readOnly && (
              <div className="pfe-readonly-note">
                Read-only while the build is running — pause or stop the build to make edits.
              </div>
            )}
            {fileState === 'loading' && <div className="pfe-empty">Loading…</div>}
            {fileState === 'error' && <div className="pfe-error">{fileError}</div>}
            {(fileState === 'ready' || fileState === 'saving') && (
              <textarea
                className="pfe-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                readOnly={readOnly}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  expandedDirs,
  onToggleDir,
  activePath,
  onOpenFile,
  onDelete,
  onRename,
  onNewChild,
  pendingNew,
  newName,
  setNewName,
  onConfirmNew,
  onCancelNew,
  readOnly,
}) {
  const isDir = node.type === 'dir';
  const expanded = isDir && expandedDirs.has(node.path);
  const showNewFormHere = pendingNew && pendingNew.parentPath === node.path;

  return (
    <div className="pfe-node" style={{ '--depth': depth }}>
      <div className={`pfe-row pfe-row-${node.type}${activePath === node.path ? ' active' : ''}`}>
        <button
          type="button"
          className="pfe-row-main"
          onClick={() => (isDir ? onToggleDir(node.path) : onOpenFile(node.path))}
        >
          <span className={`pfe-caret${isDir ? '' : ' pfe-caret-hidden'}${expanded ? ' open' : ''}`} aria-hidden="true">▸</span>
          <span className="pfe-name">{node.name}{isDir ? '/' : ''}</span>
          {node.skipped && <span className="pfe-skip-tag">not shown</span>}
        </button>
        {!readOnly && (
          <span className="pfe-row-actions">
            {isDir && (
              <>
                <button type="button" title="New file here" onClick={() => onNewChild(node.path, false)}>+f</button>
                <button type="button" title="New folder here" onClick={() => onNewChild(node.path, true)}>+d</button>
              </>
            )}
            <button type="button" title="Rename" onClick={() => onRename(node.path)}>✎</button>
            <button type="button" title="Delete" onClick={() => onDelete(node.path)}>×</button>
          </span>
        )}
      </div>

      {showNewFormHere && (
        <form className="pfe-new-form pfe-new-form-nested" style={{ '--depth': depth + 1 }} onSubmit={onConfirmNew}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={pendingNew.isDir ? 'folder-name' : 'file-name.ext'}
          />
          <button type="submit">Add</button>
          <button type="button" onClick={onCancelNew}>Cancel</button>
        </form>
      )}

      {isDir && expanded && !node.skipped && node.children && (
        <div className="pfe-children">
          {node.children.length === 0 && <div className="pfe-empty-dir" style={{ '--depth': depth + 1 }}>empty</div>}
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onDelete={onDelete}
              onRename={onRename}
              onNewChild={onNewChild}
              pendingNew={pendingNew}
              newName={newName}
              setNewName={setNewName}
              onConfirmNew={onConfirmNew}
              onCancelNew={onCancelNew}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}
