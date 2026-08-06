import JSZip from 'jszip';

// Kept in sync with app/validate.py — purely cosmetic here (the server is
// still the source of truth and re-validates independently), this just lets
// the browser flag the same things the uploader is about to be told about,
// before the archive ever leaves the browser.
const FORBIDDEN_TOP_LEVEL = new Set(['android', 'ios', 'platforms']);
// Subset of FORBIDDEN_TOP_LEVEL a Flutter project is allowed to bring with
// it — these are the project's own native platform folders, not build
// output. Mirrors validate.py's FLUTTER_ALLOWED_TOP_LEVEL.
const FLUTTER_ALLOWED_TOP_LEVEL = new Set(['android', 'ios']);
const ROOT_MARKERS = new Set([
  'package.json',
  'settings.gradle',
  'settings.gradle.kts',
  'build.gradle',
  'build.gradle.kts',
  'pubspec.yaml',
]);
const WRAPPER_FILES = new Set([
  'gradlew',
  'gradlew.bat',
  'gradle-wrapper.jar',
  'gradle-wrapper.properties',
]);

// Cap how much of a huge archive gets built into DOM nodes / animated in —
// past this, the raw count still shows, just without a row-per-file.
const MAX_RENDERED_ENTRIES = 400;

function flagFor(name, depth, isDir, hasPubspec) {
  if (isDir && depth === 0 && FORBIDDEN_TOP_LEVEL.has(name.toLowerCase())) {
    if (hasPubspec && FLUTTER_ALLOWED_TOP_LEVEL.has(name.toLowerCase())) return null;
    return 'forbidden';
  }
  // Root markers are searched for anywhere in the archive, not just at
  // the top level — the server (validate.py's _locate_project_root) does
  // the same, in case the project is nested a folder or two deep. This
  // preview just needs to agree with that so it doesn't warn falsely.
  if (!isDir && ROOT_MARKERS.has(name)) return 'marker';
  if (!isDir && WRAPPER_FILES.has(name)) return 'wrapper';
  return null;
}

/**
 * Reads a .zip File in the browser (no upload involved) and returns a
 * nested tree plus a lightweight summary — the same shape of information
 * app/validate.py checks server-side, surfaced early so the person can see
 * what's about to be sent.
 */
export async function inspectZip(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter((e) => e.name && !e.name.startsWith('__MACOSX/'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const root = { name: '', path: '', type: 'dir', depth: -1, children: new Map() };
  let fileCount = 0;
  let dirCount = 0;
  let truncated = false;
  let rendered = 0;
  // Flat record of every flagged node, independent of the nested tree
  // structure — this is what detection runs against, so it still catches a
  // package.json/settings.gradle/pubspec.yaml (or a forbidden folder) one
  // level down inside a single top-level wrapper folder, same as
  // validate.py's raw entry scan does before it ever flattens anything.
  const flagged = [];

  // Pre-scan pass: same reason as validate.py's own pre-scan — whether
  // android/ or ios/ at the top level is allowed depends on whether this
  // is a Flutter upload, and entries are visited in alphabetical order
  // (so e.g. "android/..." would otherwise be seen before "pubspec.yaml").
  const hasPubspec = entries.some((e) => {
    const parts = e.name.split('/').filter(Boolean);
    return parts.length > 0 && parts[parts.length - 1] === 'pubspec.yaml';
  });

  for (const entry of entries) {
    const isDir = entry.dir || entry.name.endsWith('/');
    const parts = entry.name.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let node = root;
    let pathSoFar = '';
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const thisIsDir = !isLast || isDir;

      if (!node.children.has(part)) {
        if (rendered >= MAX_RENDERED_ENTRIES) {
          truncated = true;
          return;
        }
        rendered += 1;
        const flag = flagFor(part, i, thisIsDir, hasPubspec);
        const newNode = {
          name: part,
          path: pathSoFar,
          type: thisIsDir ? 'dir' : 'file',
          depth: i,
          flag,
          children: thisIsDir ? new Map() : null,
        };
        node.children.set(part, newNode);
        if (flag) flagged.push(newNode);
        if (thisIsDir) dirCount += 1;
        else fileCount += 1;
      }
      node = node.children.get(part);
    });
  }

  function toArray(node) {
    if (!node.children) return node;
    const kids = Array.from(node.children.values())
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      .map(toArray);
    return { ...node, children: kids };
  }

  const tree = toArray(root).children;

  const forbiddenAtRoot = flagged.filter((n) => n.flag === 'forbidden').map((n) => n.name);
  const hasPackageJson = flagged.some((n) => n.flag === 'marker' && n.name === 'package.json');
  const hasSettingsGradle = flagged.some(
    (n) => n.flag === 'marker' && (n.name === 'settings.gradle' || n.name === 'settings.gradle.kts')
  );

  let projectType = null;
  if (hasPubspec) projectType = 'flutter';
  else if (hasPackageJson) projectType = 'capacitor-web';
  else if (hasSettingsGradle) projectType = 'native-android';

  return {
    tree,
    fileCount,
    dirCount,
    truncated,
    forbiddenAtRoot,
    projectType,
  };
}
