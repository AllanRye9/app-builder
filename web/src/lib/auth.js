const KEY = 'apkit:token';

export function getToken() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage disabled (private mode, locked-down browser) — the session
    // still works for the rest of this tab's lifetime via in-memory state
    // in AuthGate, it just won't survive a reload.
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
