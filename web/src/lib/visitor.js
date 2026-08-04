const KEY = 'apk-builder:visitor-id';

// Not a fingerprint, not tied to anything identifying — just a random id
// stashed in localStorage so the same browser doesn't inflate the "total
// visitors" count on every reload. First visit ever generates one; every
// visit after that reuses it.
export function getVisitorId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || `v${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Storage disabled (private mode, locked-down browser, etc.) — fall
    // back to a per-tab id; the visit still gets counted, just not deduped
    // against this same browser's future visits.
    return `v${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
