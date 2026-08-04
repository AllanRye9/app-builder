// Shared Android permission list — surfaced in the confirmation popup
// (PermissionsConfirmModal.jsx) that appears right after a file is picked.
// Not exhaustive — the server accepts the fuller whitelist in
// app/permissions.py, this is just the shortlist worth a checkbox. Nothing
// here is applied unless the uploader checks it: an unmodified project
// with nothing checked builds with whatever permissions (if any) it
// already declares, untouched.
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
