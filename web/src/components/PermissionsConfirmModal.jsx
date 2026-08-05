const OPTIONS = [
  { value: 'android.permission.INTERNET', label: 'Internet access', hint: 'Needed for almost any app that calls an API' },
  { value: 'android.permission.ACCESS_NETWORK_STATE', label: 'Network state', hint: 'Detect online/offline' },
  { value: 'android.permission.ACCESS_FINE_LOCATION', label: 'Precise location' },
  { value: 'android.permission.ACCESS_COARSE_LOCATION', label: 'Approximate location' },
  { value: 'android.permission.CAMERA', label: 'Camera' },
  { value: 'android.permission.RECORD_AUDIO', label: 'Microphone' },
  { value: 'android.permission.READ_MEDIA_IMAGES', label: 'Read photos' },
  { value: 'android.permission.POST_NOTIFICATIONS', label: 'Notifications' },
  { value: 'android.permission.WRITE_EXTERNAL_STORAGE', label: 'Storage (legacy)' },
];

// Files are staged (not yet uploaded) the moment they're dropped — see
// App.jsx's pendingFiles state. Nothing is sent to the server until this
// modal's Confirm button is clicked; Cancel discards the selection
// entirely, same as never having dropped it.
export default function PermissionsConfirmModal({ files, selected, onChange, onConfirm, onCancel }) {
  if (!files || files.length === 0) return null;

  function toggle(value) {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-panel confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm build" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Review before building</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="modal-scroll">
          <div className="confirm-files">
            <div className="confirm-files-label">
              {files.length} archive{files.length === 1 ? '' : 's'} ready to upload
            </div>
            <ul className="confirm-files-list">
              {files.map((f) => (
                <li key={`${f.name}-${f.size}`}>
                  <span className="confirm-file-name">{f.name}</span>
                  <span className="confirm-file-size">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="confirm-permissions">
            <div className="confirm-files-label">Android permissions</div>
            <p className="permissions-hint">
              Only what you check here gets added to the app — nothing is added automatically. Leave
              everything unchecked to build with whatever the project already declares. This applies
              to every archive above.
            </p>
            <div className="permissions-grid">
              {OPTIONS.map((opt) => (
                <label key={opt.value} className="permissions-option">
                  <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => toggle(opt.value)} />
                  <span>
                    {opt.label}
                    {opt.hint && <span className="permissions-option-hint"> — {opt.hint}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="modal-btn-primary" onClick={onConfirm}>
            Confirm &amp; start build{files.length > 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
