import { useEffect } from 'react';
import PermissionsPicker from './PermissionsPicker.jsx';

// Shown the moment files are picked/dropped, before anything is sent to
// the server. Nothing uploads and no build starts until Confirm is
// pressed — Cancel discards the pending files entirely. Permissions
// picked here apply to every file in this batch, same as the old
// always-visible sidebar picker did — just moved to the point where it
// actually matters instead of sitting in the right side panel.
export default function PermissionsConfirmModal({ open, files, selected, onChange, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="perm-modal-overlay" onClick={onCancel}>
      <div
        className="perm-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm Android permissions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="perm-modal-head">
          <div>
            <div className="perm-modal-eyebrow">Before the build starts</div>
            <h2>Confirm Android permissions</h2>
          </div>
          <button type="button" className="perm-modal-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="perm-modal-scroll hide-scrollbar">
          <p className="perm-modal-files-label">
            Uploading {files.length === 1 ? '1 file' : `${files.length} files`}:
          </p>
          <ul className="perm-modal-files">
            {files.map((f) => <li key={f.name}>{f.name}</li>)}
          </ul>

          <PermissionsPicker selected={selected} onChange={onChange} />
        </div>

        <div className="perm-modal-actions">
          <button type="button" className="perm-modal-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="perm-modal-confirm" onClick={onConfirm}>
            Confirm &amp; start build
          </button>
        </div>
      </div>
    </div>
  );
}
