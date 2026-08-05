// Common permissions surfaced up front; not exhaustive — the server accepts
// the fuller whitelist in src/permissions.js, this is just the shortlist
// worth a checkbox. Nothing here is applied unless the uploader checks it:
// an unmodified project with nothing checked builds with whatever
// permissions (if any) it already declares, untouched.
export const OPTIONS = [
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

// Bare content only — the checkbox grid itself. Rendered inside
// PermissionsConfirmModal.jsx, the pop-up shown right after files are
// picked and before the upload/build actually starts.
export default function PermissionsPicker({ selected, onChange }) {
  function toggle(value) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  return (
    <div className="permissions-picker">
      <p className="permissions-hint">
        Only what you check here gets added to the app — nothing is added automatically. Leave
        everything unchecked to build with whatever the project already declares.
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
    </div>
  );
}
