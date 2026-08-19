import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement matchMedia — App.jsx's mobile-breakpoint sync
// effect calls it unconditionally on mount, which otherwise throws inside
// every test that renders <App /> or <Dashboard />, regardless of what
// that test is actually about.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
