import { useEffect, useRef, useState } from 'react';
import { fetchProjectFileContent, saveProjectFileContent } from '../api.js';

const SETTINGS_KEY = 'apkit:fileEditorSettings';
const AUTOSAVE_DELAY_MS = 1200;

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { autoSave: true, wordWrap: true, fontSize: 12.5 };
    const parsed = JSON.parse(raw);
    return {
      autoSave: parsed.autoSave !== false,
      wordWrap: parsed.wordWrap !== false,
      fontSize: typeof parsed.fontSize === 'number' ? parsed.fontSize : 12.5,
    };
  } catch {
    return { autoSave: true, wordWrap: true, fontSize: 12.5 };
  }
}

function persistSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings are a convenience, not critical — fine to lose across a
    // private-browsing session or a full storage quota.
  }
}

// Opened on top of ProjectEditorModal when a file is clicked. One file at a
// time, plain-text only (matches the server-side size/type limits on the
// file-content API) — deliberately not a full IDE.
//
// `onClose(savedPath)` fires once the popup is actually dismissed —
// `savedPath` is the path if a save happened as part of closing, or null
// if the person just walked away from unsaved changes (still possible via
// "Discard", see below) or there was nothing to save. The caller
// (ProjectEditorModal) uses this to refresh the tree / re-run error
// highlighting after an edit.
export default function FileEditorPopup({ jobId, path, readOnly, onClose }) {
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [fileState, setFileState] = useState('loading'); // loading | ready | saving | error
  const [fileError, setFileError] = useState(null);
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState(null); // null | 'pending' | 'saving' | 'saved'
  const autoSaveTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setFileState('loading');
    setFileError(null);
    setAutoSaveStatus(null);
    fetchProjectFileContent(jobId, path)
      .then((r) => {
        if (cancelled) return;
        setContent(r.content);
        setSavedContent(r.content);
        setFileState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setFileError(err.message);
        setFileState('error');
      });
    return () => {
      cancelled = true;
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, path]);

  const dirty = fileState === 'ready' && content !== savedContent;

  async function doSave() {
    if (readOnly) return false;
    setFileState('saving');
    setAutoSaveStatus('saving');
    try {
      await saveProjectFileContent(jobId, path, content);
      setSavedContent(content);
      setFileState('ready');
      setAutoSaveStatus('saved');
      return true;
    } catch (err) {
      setFileError(err.message);
      setFileState('error');
      setAutoSaveStatus(null);
      return false;
    }
  }

  // Auto-save: debounced, so a burst of keystrokes triggers one save
  // shortly after typing stops, not one save per keystroke.
  useEffect(() => {
    if (!settings.autoSave || readOnly) return undefined;
    if (fileState !== 'ready' || content === savedContent) return undefined;
    setAutoSaveStatus('pending');
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      doSave();
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, settings.autoSave]);

  function updateSetting(patch) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      persistSettings(next);
      return next;
    });
  }

  async function handlePrimaryAction() {
    if (!dirty) {
      onClose(null);
      return;
    }
    const ok = await doSave();
    onClose(ok ? path : null);
  }

  function handleDiscard() {
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    onClose(null);
  }

  return (
    <div className="modal-overlay file-editor-overlay" onClick={dirty ? undefined : () => onClose(null)}>
      <div
        className="modal-panel file-editor-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Editing ${path}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head file-editor-head">
          <div className="file-editor-path" title={path}>
            {path}
            {dirty && <span className="pfe-dirty-dot" title="Unsaved changes" />}
          </div>
          <div className="file-editor-head-actions">
            {settings.autoSave && (
              <span className={`autosave-status autosave-status-${autoSaveStatus || 'idle'}`}>
                {autoSaveStatus === 'pending' && 'Auto-save pending…'}
                {autoSaveStatus === 'saving' && 'Saving…'}
                {autoSaveStatus === 'saved' && 'Saved'}
                {!autoSaveStatus && 'Auto-save on'}
              </span>
            )}
            <div className="file-editor-settings">
              <button
                type="button"
                className="pfe-icon-btn file-editor-settings-btn"
                title="Editor settings"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((o) => !o)}
              >
                ⚙
              </button>
              {settingsOpen && (
                <div className="file-editor-settings-menu" role="menu">
                  <label className="file-editor-settings-row">
                    <input
                      type="checkbox"
                      checked={settings.autoSave}
                      onChange={(e) => updateSetting({ autoSave: e.target.checked })}
                    />
                    Auto-save while typing
                  </label>
                  <label className="file-editor-settings-row">
                    <input
                      type="checkbox"
                      checked={settings.wordWrap}
                      onChange={(e) => updateSetting({ wordWrap: e.target.checked })}
                    />
                    Wrap long lines
                  </label>
                  <div className="file-editor-settings-row file-editor-settings-fontsize">
                    <span>Font size</span>
                    <button type="button" onClick={() => updateSetting({ fontSize: Math.max(10, settings.fontSize - 1) })}>−</button>
                    <span>{settings.fontSize}px</span>
                    <button type="button" onClick={() => updateSetting({ fontSize: Math.min(18, settings.fontSize + 1) })}>+</button>
                  </div>
                </div>
              )}
            </div>
            <button type="button" className="modal-close" aria-label="Close editor" onClick={() => (dirty ? null : onClose(null))}>×</button>
          </div>
        </div>

        {readOnly && (
          <div className="pfe-readonly-note">
            Read-only while the build is running — pause or stop the build to make edits.
          </div>
        )}

        <div className="file-editor-body">
          {fileState === 'loading' && <div className="pfe-empty">Loading…</div>}
          {fileState === 'error' && <div className="pfe-error">{fileError}</div>}
          {(fileState === 'ready' || fileState === 'saving') && (
            <textarea
              className="pfe-textarea file-editor-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              readOnly={readOnly}
              style={{
                whiteSpace: settings.wordWrap ? 'pre-wrap' : 'pre',
                fontSize: `${settings.fontSize}px`,
              }}
            />
          )}
        </div>

        {!readOnly && (
          <div className="modal-actions file-editor-actions">
            {dirty && (
              <button type="button" className="modal-btn-secondary" onClick={handleDiscard}>
                Discard changes
              </button>
            )}
            <button
              type="button"
              className={dirty ? 'modal-btn-primary' : 'modal-btn-secondary'}
              onClick={handlePrimaryAction}
              disabled={fileState === 'saving'}
            >
              {fileState === 'saving' ? 'Saving…' : dirty ? 'Add changes to file' : 'Cancel'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
