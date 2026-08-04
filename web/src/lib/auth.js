const TOKEN_KEY = 'apkBuilderAuthToken';
const EMAIL_KEY = 'apkBuilderAuthEmail';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function getStoredEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuth(token, email) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMAIL_KEY, email || '');
  } catch {
    // Private-browsing/storage-disabled contexts — the session still works
    // for this tab via App.jsx's in-memory state, it just won't survive a
    // reload.
  }
}

export function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
  } catch {
    // see setAuth
  }
}
