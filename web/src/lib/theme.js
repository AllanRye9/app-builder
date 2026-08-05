export const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'White' },
  { id: 'ocean', label: 'Ocean' },
];

const KEY = 'apkit:theme';

export function getStoredTheme() {
  try {
    const stored = localStorage.getItem(KEY);
    if (THEMES.some((t) => t.id === stored)) return stored;
  } catch {
    // ignore — storage may be unavailable
  }
  return 'dark';
}

export function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  try {
    localStorage.setItem(KEY, themeId);
  } catch {
    // theme still applies for this session even if it can't persist
  }
}
