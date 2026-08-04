import JSZip from 'jszip';

// Mirrors app/validate.py so the tree preview flags the same things the
// server will reject — the point is to catch a bad archive before the
// upload round-trip, not to duplicate the server's authority over it.
const FORBIDDEN_TOP_LEVEL = new Set(['android', 'ios', 'platforms']);

const ALLOWED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.md', '.mjs', '.cjs', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.txt',
  '.gitignore', '.npmrc', '.yml', '.yaml', '.lock',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a', '.pdf',
  '.kt', '.kts', '.java', '.gradle', '.pro', '.properties', '.aidl', '.xml',
]);

const ALLOWED_BASENAMES = new Set([
  'license', 'license.md', 'license.txt', 'readme', 'dockerfile',
  '.env.example', '.env.sample',
  'gradlew', 'gradlew.bat', 'gradle-wrapper.jar', 'gradle-wrapper.properties',
]);

const PACKAGE_JSON_RE = /(^|\/)package\.json$/;
const SETTINGS_GRADLE_RE = /(^|\/)settings\.gradle(\.kts)?$/;
const BUILD_GRADLE_RE = /(^|\/)build\.gradle(\.kts)?$/;

function isAllowed(entryName) {
  const base = entryName.split('/').pop().toLowerCase();
  if (ALLOWED_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot);
  return !ext || ALLOWED_EXTENSIONS.has(ext);
}

// Reads a .zip File in the browser (no upload involved) and returns a
// tree + a small summary of what the server would decide about it, so the
// person can see and fix problems before spending an upload round-trip.
export async function readZipStructure(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));

  const rootChildren = new Map();
  let fileCount = 0;
  let skippedCount = 0;
  let hasPackageJson = false;
  let hasSettingsGradle = false;
  let hasBuildGradle = false;
  let forbiddenFolder = null;
  let wrapperFiles = { gradlew: false, gradlewBat: false, wrapperJar: false, wrapperProps: false };

  for (const entry of entries) {
    const cleanName = entry.name.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = cleanName.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    const top = parts[0].toLowerCase();
    if (FORBIDDEN_TOP_LEVEL.has(top) && !forbiddenFolder) forbiddenFolder = parts[0];

    const atRoot = parts.length <= 2;
    if (!entry.dir) {
      if (atRoot && PACKAGE_JSON_RE.test(cleanName)) hasPackageJson = true;
      if (atRoot && SETTINGS_GRADLE_RE.test(cleanName)) hasSettingsGradle = true;
      if (atRoot && BUILD_GRADLE_RE.test(cleanName)) hasBuildGradle = true;
      if (cleanName.endsWith('gradlew')) wrapperFiles.gradlew = true;
      if (cleanName.endsWith('gradlew.bat')) wrapperFiles.gradlewBat = true;
      if (cleanName.endsWith('gradle/wrapper/gradle-wrapper.jar')) wrapperFiles.wrapperJar = true;
      if (cleanName.endsWith('gradle/wrapper/gradle-wrapper.properties')) wrapperFiles.wrapperProps = true;
    }

    // Build the nested map that becomes the rendered tree.
    let level = rootChildren;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1 && !entry.dir;
      const path = parts.slice(0, i + 1).join('/');
      if (!level.has(part)) {
        level.set(part, {
          name: part,
          path,
          type: isLeaf ? 'file' : 'dir',
          flagged: FORBIDDEN_TOP_LEVEL.has(part.toLowerCase()) && i === 0,
          marker: null,
          children: new Map(),
        });
      }
      const node = level.get(part);
      if (isLeaf) {
        if (PACKAGE_JSON_RE.test(path) && parts.length <= 2) node.marker = 'entry';
        else if (SETTINGS_GRADLE_RE.test(path) && parts.length <= 2) node.marker = 'entry';
        else if (!isAllowed(cleanName)) node.marker = 'skipped';
      }
      level = node.children;
    });

    if (!entry.dir) {
      if (isAllowed(cleanName)) fileCount += 1;
      else skippedCount += 1;
    }
  }

  function finalize(map) {
    return Array.from(map.values())
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      .map((node) => ({ ...node, children: finalize(node.children) }));
  }

  const projectType = hasPackageJson ? 'capacitor-web' : (hasSettingsGradle && hasBuildGradle) ? 'native-android' : null;

  let wrapperComplete = true;
  const missingWrapper = [];
  if (projectType === 'native-android') {
    if (!wrapperFiles.gradlew) missingWrapper.push('gradlew');
    if (!wrapperFiles.wrapperJar) missingWrapper.push('gradle/wrapper/gradle-wrapper.jar');
    if (!wrapperFiles.wrapperProps) missingWrapper.push('gradle/wrapper/gradle-wrapper.properties');
    wrapperComplete = missingWrapper.length === 0;
  }

  return {
    tree: finalize(rootChildren),
    fileCount,
    skippedCount,
    projectType,
    forbiddenFolder,
    wrapperComplete,
    missingWrapper,
  };
}
