import { useEffect } from 'react';
import { OPTIONS } from '../lib/permissionOptions.js';

// Shown the moment files are picked/dropped, before anything is sent to
// the server. Nothing uploads and no build starts until Confirm is
// pressed — Cancel discards the pending files entirely. Permissions
// picked here apply to every file in this batch, same as the picker did
// before, just moved to the point where it actually matters.
export default function PermissionsConfirmModal({ open, files, selected, onChange, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  function toggle(value) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  return (
    <div className="docs-overlay" onClick={onCancel}>
      <div
        className="docs-panel perm-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm Android permissions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="docs-head">
          <h2>Confirm before building</h2>
          <button type="button" className="docs-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="docs-scroll">
          <p className="permissions-hint" style={{ marginBottom: 14 }}>
            About to upload {files.length === 1 ? '1 file' : `${files.length} files`}:
          </p>
          <ul className="docs-flat-list" style={{ marginBottom: 18 }}>
            {files.map((f) => <li key={f.name}>{f.name}</li>)}
          </ul>

          <p className="permissions-hint">
            Only what you check here gets added to the app — nothing is added automatically.
            Leave everything unchecked to build with whatever the project already declares.
          </p>
          <div className="permissions-grid">
            {OPTIONS.map((opt) => (
              <label key={opt.value} className="permissions-option">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                />
                <span>
                  {opt.label}
                  {opt.hint && <span className="permissions-option-hint"> — {opt.hint}</span>}
                </span>
              </label>
            ))}
          </div>

          <div className="perm-modal-actions">
            <button type="button" className="perm-modal-cancel" onClick={onCancel}>Cancel</button>
            <button type="button" className="perm-modal-confirm" onClick={onConfirm}>
              Confirm &amp; start build
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
