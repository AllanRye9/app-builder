'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

class ValidationError extends Error {}

// android/, ios/, and platforms/ are genuinely generated output — an
// existing one would collide with what the build creates and can't be
// safely merged, so those still hard-reject. A capacitor.config.json/.ts by
// itself is different: plenty of real Capacitor-ready projects ship one
// deliberately (it's how you turn a plain web app into one), and it
// doesn't conflict with anything — buildRunner.js detects it and reuses it
// instead of overwriting it via `cap init`, rather than rejecting it here.
const FORBIDDEN_TOP_LEVEL = new Set(['android', 'ios', 'platforms']);

// Only these file types are trusted to build the app itself. Anything else
// in the archive (editor/OS cruft, license files, whatever) is simply
// skipped rather than failing the whole upload — none of it is needed to
// build the APK.
//
// Covers both project kinds this builder accepts:
//  - a web project (React/Vite/etc.) wrapped into Android via Capacitor
//  - a native Android project written in Kotlin and/or Java, built with
//    its own Gradle project directly (no Capacitor/web step at all)
const ALLOWED_EXTENSIONS = new Set([
  // Web project sources
  '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.md', '.mjs', '.cjs', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.txt',
  '.gitignore', '.npmrc', '.yml', '.yaml', '.lock',
  // Media assets — common in real-world apps (splash videos, sound effects,
  // etc.) and otherwise silently dropped, which just trades a build failure
  // for a broken-looking app.
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a', '.pdf',
  // Native Android project sources (Kotlin/Java) and their Gradle build
  // files. '.jar' is deliberately NOT included here — see ALLOWED_BASENAMES
  // for why the one legitimate jar (the Gradle wrapper) is allowlisted by
  // exact name instead of opening up arbitrary binary jars.
  '.kt', '.kts', '.java', '.gradle', '.pro', '.properties', '.aidl', '.xml',
]);

// Filenames (not extensions) that are also fine to skip past — no extension,
// or an extension that's ambiguous/misleading outside this specific name.
// path.extname('.env.example') is '.example', not '.env.example' (Node
// treats the part after the first dot in a dotfile as the "name"), so an
// entry in ALLOWED_EXTENSIONS for '.env.example' would never actually
// match anything — matching on the full basename here is the correct fix.
const ALLOWED_BASENAMES = new Set([
  'license', 'license.md', 'license.txt', 'readme', 'dockerfile',
  '.env.example', '.env.sample',
  // Gradle wrapper — required for a native Android project to build with
  // its own pinned Gradle version. 'gradle-wrapper.jar' is the one binary
  // jar allowlisted, and only under this exact name (not '.jar' generally),
  // to keep arbitrary binaries out of the archive.
  'gradlew', 'gradlew.bat', 'gradle-wrapper.jar', 'gradle-wrapper.properties',
]);

function isSafeEntryName(name) {
  // Reject absolute paths, zip-slip traversal, and null bytes.
  if (name.includes('\0')) return false;
  const normalized = path.normalize(name);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  return true;
}

function isAllowedFile(entryName) {
  const base = path.basename(entryName).toLowerCase();
  if (ALLOWED_BASENAMES.has(base)) return true;
  const ext = path.extname(entryName).toLowerCase();
  return !ext || ALLOWED_EXTENSIONS.has(ext);
}

// A project is buildable one of two ways, decided purely by what it
// contains — never by a flag the uploader has to set:
//  - 'capacitor-web': a package.json at the root (React/Vite/etc.), wrapped
//    into an Android shell via Capacitor at build time.
//  - 'native-android': a Gradle project at the root (settings.gradle(.kts)
//    + a root build.gradle(.kts), i.e. what `File > New Project` produces
//    in Android Studio for a Kotlin or Java app) with no wrapping needed —
//    its own gradlew builds the APK directly.
function detectProjectType(destDir) {
  if (fs.existsSync(path.join(destDir, 'package.json'))) return 'capacitor-web';
  const hasSettingsGradle =
    fs.existsSync(path.join(destDir, 'settings.gradle')) ||
    fs.existsSync(path.join(destDir, 'settings.gradle.kts'));
  const hasRootBuildGradle =
    fs.existsSync(path.join(destDir, 'build.gradle')) ||
    fs.existsSync(path.join(destDir, 'build.gradle.kts'));
  if (hasSettingsGradle && hasRootBuildGradle) return 'native-android';
  return null;
}

function validateAndExtract(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length === 0) {
    throw new ValidationError('The archive is empty.');
  }

  let hasPackageJson = false;
  let hasGradleProject = false;
  const skipped = [];
  const toExtract = [];

  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, '/');

    if (!isSafeEntryName(entryName)) {
      throw new ValidationError(`Unsafe path in archive: ${entryName}`);
    }

    const parts = entryName.split('/').filter(Boolean);
    const topLevel = parts[0] ? parts[0].toLowerCase() : '';

    if (FORBIDDEN_TOP_LEVEL.has(topLevel)) {
      throw new ValidationError(
        `Archive already contains "${parts[0]}". Upload a plain React (or native Android) project — the "${parts[0]}" folder is generated by the build.`
      );
    }

    // Only trust these markers at the project root (depth 0, or depth 1 if
    // the whole zip is wrapped in a single top folder — flattened below).
    const atRootDepth = parts.length <= 2;
    if (atRootDepth && /(^|\/)package\.json$/.test(entryName)) hasPackageJson = true;
    if (atRootDepth && /(^|\/)settings\.gradle(\.kts)?$/.test(entryName)) hasGradleProject = true;

    if (entry.isDirectory) {
      toExtract.push(entry);
      continue;
    }

    if (isAllowedFile(entryName)) {
      toExtract.push(entry);
    } else {
      skipped.push(entryName);
    }
  }

  if (!hasPackageJson && !hasGradleProject) {
    throw new ValidationError(
      'No package.json (web/Capacitor project) or settings.gradle (native Android project) found at the project root.'
    );
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of toExtract) {
    zip.extractEntryTo(entry, destDir, true, true);
  }

  // If the zip wrapped everything in a single top-level folder, flatten it
  // so the project's own root markers end up directly inside destDir.
  const rootEntries = fs.readdirSync(destDir);
  if (rootEntries.length === 1) {
    const onlyPath = path.join(destDir, rootEntries[0]);
    const looksLikeProjectRoot =
      fs.statSync(onlyPath).isDirectory() &&
      (fs.existsSync(path.join(onlyPath, 'package.json')) ||
        fs.existsSync(path.join(onlyPath, 'settings.gradle')) ||
        fs.existsSync(path.join(onlyPath, 'settings.gradle.kts')));
    if (looksLikeProjectRoot) {
      for (const child of fs.readdirSync(onlyPath)) {
        fs.renameSync(path.join(onlyPath, child), path.join(destDir, child));
      }
      fs.rmSync(onlyPath, { recursive: true, force: true });
    }
  }

  const projectType = detectProjectType(destDir);
  if (!projectType) {
    throw new ValidationError('Could not confirm a package.json or settings.gradle at the project root after extraction.');
  }

  if (projectType === 'native-android' && !fs.existsSync(path.join(destDir, 'gradlew'))) {
    throw new ValidationError(
      'Native Android projects must include the Gradle wrapper (gradlew, gradlew.bat, gradle/wrapper/gradle-wrapper.*) so the build uses your pinned Gradle version.'
    );
  }

  return { skipped, projectType };
}

module.exports = { validateAndExtract, detectProjectType, ValidationError };
