export const THEMES = [
  { id: 'dark', label: 'Dark', glyph: '◐' },
  { id: 'light', label: 'Light', glyph: '○' },
  { id: 'ocean', label: 'Ocean', glyph: '◑' },
];

const KEY = 'apk-builder:theme';

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
    // ignore — theme still applies for this session even if it can't persist
  }
}
