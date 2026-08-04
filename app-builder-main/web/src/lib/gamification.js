const KEY = 'apk-builder:progress';

export const BADGES = [
  { id: 'first-upload', label: 'First Drop', glyph: '📦', desc: 'Uploaded your first project archive.' },
  { id: 'first-success', label: 'Shipped It', glyph: '🚀', desc: 'Got your first APK across the finish line.' },
  { id: 'five-builds', label: 'Regular', glyph: '🔁', desc: 'Started 5 builds on this build floor.' },
  { id: 'streak-3', label: 'Hat Trick', glyph: '🎯', desc: '3 successful builds in a row, no failures between them.' },
  { id: 'explorer', label: 'Explorer', glyph: '🗺️', desc: 'Opened the file structure docs.' },
  { id: 'inspector', label: 'Inspector', glyph: '🔍', desc: 'Expanded a project structure preview.' },
  { id: 'native-and-web', label: 'Full Stack', glyph: '🧩', desc: 'Built both a web/Capacitor project and a native Android project.' },
];

// XP required to *reach* level N (index 0 = level 1's floor). Deliberately
// front-loaded and gentle — this is flavor on top of a build tool, not a
// grind, so leveling up should happen often early on.
const LEVEL_THRESHOLDS = [0, 20, 50, 90, 140, 200, 280, 380, 500, 650, 820];

function defaultState() {
  return {
    xp: 0,
    uploads: 0,
    successes: 0,
    failures: 0,
    currentStreak: 0,
    docsViews: 0,
    structureViews: 0,
    sawWeb: false,
    sawNative: false,
    badges: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // ignore — progress just won't persist this session
  }
}

export function levelForXp(xp) {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

export function levelProgress(xp) {
  const level = levelForXp(xp);
  const floor = LEVEL_THRESHOLDS[level - 1] ?? 0;
  const nextRaw = LEVEL_THRESHOLDS[level];
  const ceiling = nextRaw ?? floor + 200;
  const pct = nextRaw ? Math.min(100, Math.round(((xp - floor) / (ceiling - floor)) * 100)) : 100;
  return { level, floor, ceiling, pct, maxed: !nextRaw };
}

function checkBadges(state) {
  const unlocked = [];
  const has = (id) => state.badges.includes(id);
  const grant = (id) => { if (!has(id)) { state.badges.push(id); unlocked.push(id); } };

  if (state.uploads >= 1) grant('first-upload');
  if (state.successes >= 1) grant('first-success');
  if (state.uploads >= 5) grant('five-builds');
  if (state.currentStreak >= 3) grant('streak-3');
  if (state.docsViews >= 1) grant('explorer');
  if (state.structureViews >= 1) grant('inspector');
  if (state.sawWeb && state.sawNative) grant('native-and-web');

  return unlocked;
}

// Every call returns { state, gainedXp, leveledUp, newBadges } so the
// caller can decide what to celebrate (toast, confetti, badge pop) without
// this module knowing anything about the UI.
function applyEvent(mutate, xpGain) {
  const state = load();
  const beforeLevel = levelForXp(state.xp);
  mutate(state);
  state.xp += xpGain;
  const newBadges = checkBadges(state);
  const afterLevel = levelForXp(state.xp);
  save(state);
  return { state, gainedXp: xpGain, leveledUp: afterLevel > beforeLevel, newBadges };
}

export function getProgress() {
  return load();
}

export function recordUpload() {
  return applyEvent((s) => { s.uploads += 1; }, 5);
}

export function recordBuildResult(status, projectType) {
  return applyEvent((s) => {
    if (status === 'success') {
      s.successes += 1;
      s.currentStreak += 1;
    } else {
      s.failures += 1;
      s.currentStreak = 0;
    }
    if (projectType === 'capacitor-web') s.sawWeb = true;
    if (projectType === 'native-android') s.sawNative = true;
  }, status === 'success' ? 20 : 2);
}

export function recordDocsView() {
  const state = load();
  if (state.docsViews >= 1) return null; // only ever awards once
  return applyEvent((s) => { s.docsViews += 1; }, 3);
}

export function recordStructureView() {
  const state = load();
  if (state.structureViews >= 1) return null; // only ever awards once
  return applyEvent((s) => { s.structureViews += 1; }, 2);
}
