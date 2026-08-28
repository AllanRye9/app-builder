"""Archive validation, extraction, and project-type detection.

Equivalent to ``src/validate.js``, using the standard-library ``zipfile``
module in place of ``adm-zip``.
"""
from __future__ import annotations

import json
import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


class ValidationError(Exception):
    pass


# android/, ios/, and platforms/ are genuinely generated output for a
# capacitor-web upload, and android/ alone is generated output for a
# native-android upload's build/ (though a native-android project's own
# android-looking root is the project itself, not a nested folder — this
# set is about a *top-level* folder named exactly "android"/"ios" showing
# up inside the archive, which for those two project kinds can only mean
# stale build output getting re-zipped) — an existing one would collide
# with what the build creates and can't be safely merged, so those still
# hard-reject for those project types. Flutter and React Native are the
# two exceptions: both ship their own android/ (and ios/) folders as real,
# hand-maintained source — not build output — so FLUTTER_ALLOWED_TOP_LEVEL
# / REACT_NATIVE_ALLOWED_TOP_LEVEL below are consulted before this rejects,
# once a pubspec.yaml or a "react-native" dependency has been spotted
# anywhere in the archive. A capacitor.config.json/.ts by itself is
# different again: plenty of real Capacitor-ready projects ship one
# deliberately, and build_runner.py detects it and reuses it instead of
# overwriting it via `cap init`, rather than rejecting it here.
FORBIDDEN_TOP_LEVEL = frozenset({"android", "ios", "platforms"})

# Subset of FORBIDDEN_TOP_LEVEL that a Flutter project is allowed to bring
# with it, since these are the project's own native platform folders, not
# something the build generates. "platforms" is deliberately NOT included
# here — that name belongs to Cordova, not Flutter, so seeing it stays a
# hard reject even for a pubspec.yaml upload.
FLUTTER_ALLOWED_TOP_LEVEL = frozenset({"android", "ios"})

# Same idea as FLUTTER_ALLOWED_TOP_LEVEL, for a React Native project: its
# android/ (and ios/) folders are the project's own native shell — created
# once by `react-native init`/`@react-native-community/cli` and then
# hand-edited by the app author (native modules, Gradle config, signing,
# permissions, ...) — never something this build generates the way
# capacitor-web's android/ is. "platforms" is still excluded for the same
# reason as above (that's Cordova's marker, not React Native's).
REACT_NATIVE_ALLOWED_TOP_LEVEL = frozenset({"android", "ios"})

# Only these file types are trusted to build the app itself. Anything else
# in the archive (editor/OS cruft, license files, whatever) is simply
# skipped rather than failing the whole upload — none of it is needed to
# build the APK.
#
# Covers all four project kinds this builder accepts:
#  - a web project (React/Vite/etc.) wrapped into Android via Capacitor
#  - a React Native project, built directly with its own bundled android/
#    Gradle project after the JS bundle is produced
#  - a native Android project written in Kotlin and/or Java, built with its
#    own Gradle project directly (no Capacitor/web step at all)
#  - a Flutter project (Dart), built with its embedded android/ Gradle
#    project via `flutter build apk`
ALLOWED_EXTENSIONS = frozenset(
    {
        # Web project sources
        ".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss", ".sass", ".less",
        ".html", ".htm", ".md", ".mjs", ".cjs", ".svg", ".png", ".jpg", ".jpeg",
        ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".txt",
        ".gitignore", ".npmrc", ".yml", ".yaml", ".lock",
        # Media assets — common in real-world apps (splash videos, sound
        # effects, etc.) and otherwise silently dropped, which just trades a
        # build failure for a broken-looking app.
        ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a", ".pdf",
        # Native Android project sources (Kotlin/Java) and their Gradle
        # build files. '.jar' is deliberately NOT included — see
        # ALLOWED_BASENAMES for why the one legitimate jar (the Gradle
        # wrapper) is allowlisted by exact name instead of opening up
        # arbitrary binary jars.
        ".kt", ".kts", ".java", ".gradle", ".pro", ".properties", ".aidl", ".xml",
        # Flutter/Dart sources. '.arb' is Flutter's localization resource
        # bundle format (JSON under the hood) — harmless text, same
        # reasoning as any other config extension above.
        ".dart", ".arb",
    }
)

# Filenames (not extensions) that are also fine to skip past — no
# extension, or an extension that's ambiguous/misleading outside this
# specific name (e.g. ".env.example" has no useful "extension" in the usual
# sense — matching on the full basename is the correct fix).
ALLOWED_BASENAMES = frozenset(
    {
        "license", "license.md", "license.txt", "readme", "dockerfile",
        ".env.example", ".env.sample",
        # Gradle wrapper — required for a native Android project to build
        # with its own pinned Gradle version. 'gradle-wrapper.jar' is the
        # one binary jar allowlisted, and only under this exact name, to
        # keep arbitrary binaries out of the archive.
        "gradlew", "gradlew.bat", "gradle-wrapper.jar", "gradle-wrapper.properties",
    }
)

_PACKAGE_JSON_RE = re.compile(r"(^|/)package\.json$")
_SETTINGS_GRADLE_RE = re.compile(r"(^|/)settings\.gradle(\.kts)?$")
_PUBSPEC_RE = re.compile(r"(^|/)pubspec\.yaml$")


def _package_json_deps_include_react_native(raw: bytes | str) -> bool:
    """True if a package.json's dependencies or devDependencies declare
    "react-native" — the one unambiguous marker distinguishing a React
    Native project from a plain web project that also happens to have a
    package.json (capacitor-web). Checked in both places, same as
    everywhere else, since a project might list it only as a
    devDependency (some templates do) — either counts.

    Deliberately permissive about malformed input: a package.json that
    fails to parse just means "not detected as React Native here", not a
    validation error — detect_project_type()'s own package.json read
    right after is what actually needs to succeed for the upload to be
    buildable at all.
    """
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        parsed = json.loads(text)
    except (UnicodeDecodeError, ValueError):
        return False
    if not isinstance(parsed, dict):
        return False
    deps: dict = {}
    for key in ("dependencies", "devDependencies"):
        section = parsed.get(key)
        if isinstance(section, dict):
            deps.update(section)
    return "react-native" in deps


@dataclass
class ExtractResult:
    skipped: list[str]
    project_type: str


def _is_safe_entry_name(name: str) -> bool:
    """Reject absolute paths, zip-slip traversal, and null bytes."""
    if "\0" in name:
        return False
    normalized = PurePosixPath(name)
    parts = normalized.parts
    if normalized.is_absolute() or (parts and parts[0] == ".."):
        return False
    # Guard against any ".." component anywhere in the path, not just a
    # leading one (mirrors path.normalize()'s traversal collapsing in the
    # original, applied against POSIX-style zip entry names).
    return ".." not in parts


def _is_allowed_file(entry_name: str) -> bool:
    base = PurePosixPath(entry_name).name.lower()
    if base in ALLOWED_BASENAMES:
        return True
    ext = PurePosixPath(entry_name).suffix.lower()
    return not ext or ext in ALLOWED_EXTENSIONS


def detect_project_type(dest_dir: Path) -> str | None:
    """A project is buildable one of four ways, decided purely by what it
    contains — never by a flag the uploader has to set:
      - 'flutter': a pubspec.yaml at the root — a Dart/Flutter project,
        built with `flutter build apk` (which drives its own embedded
        android/ Gradle project internally). Checked first since a
        pubspec.yaml is Flutter's own unambiguous marker.
      - 'react-native': a package.json at the root whose dependencies (or
        devDependencies) declare "react-native" — built directly with its
        own bundled android/ Gradle project, after the JS bundle is
        produced up front (see build_runner.py's
        _run_react_native_build). Checked before the plainer
        'capacitor-web' case below, since every React Native project also
        has a package.json but needs the very different build path.
      - 'capacitor-web': any other package.json at the root (React/Vite/
        etc.), wrapped into an Android shell via Capacitor at build time.
      - 'native-android': a Gradle project at the root
        (settings.gradle(.kts) + a root build.gradle(.kts)) with no
        wrapping needed — its own gradlew builds the APK directly.
    """
    if (dest_dir / "pubspec.yaml").exists():
        return "flutter"
    package_json_path = dest_dir / "package.json"
    if package_json_path.exists():
        try:
            if _package_json_deps_include_react_native(package_json_path.read_text(encoding="utf-8")):
                return "react-native"
        except OSError:
            pass
        return "capacitor-web"
    has_settings_gradle = (dest_dir / "settings.gradle").exists() or (dest_dir / "settings.gradle.kts").exists()
    has_root_build_gradle = (dest_dir / "build.gradle").exists() or (dest_dir / "build.gradle.kts").exists()
    if has_settings_gradle and has_root_build_gradle:
        return "native-android"
    return None


def _has_gradle_project(d: Path) -> bool:
    has_settings = (d / "settings.gradle").exists() or (d / "settings.gradle.kts").exists()
    has_build = (d / "build.gradle").exists() or (d / "build.gradle.kts").exists()
    return has_settings and has_build


def _locate_project_root(dest_dir: Path) -> Path | None:
    """Find the directory that actually holds the project, searching the
    whole extracted tree rather than assuming it landed at dest_dir.

    Some archives wrap the real project in one or more nested folders (a
    repo name, a workspace folder, a stray extra layer, ...); this walks
    everything under dest_dir and returns the shallowest directory that
    looks like a project root — a pubspec.yaml, a package.json, or a
    paired settings.gradle(.kts) + build.gradle(.kts). Returns dest_dir
    itself if it already qualifies, or None if nothing anywhere does.
    """
    def _is_root(d: Path) -> bool:
        return (d / "pubspec.yaml").exists() or (d / "package.json").exists() or _has_gradle_project(d)

    if _is_root(dest_dir):
        return dest_dir

    best: Path | None = None
    best_depth: int | None = None
    for path in dest_dir.rglob("*"):
        if not path.is_dir():
            continue
        if _is_root(path):
            depth = len(path.relative_to(dest_dir).parts)
            if best_depth is None or depth < best_depth:
                best, best_depth = path, depth
    return best


def _promote_project_root(dest_dir: Path, project_root: Path) -> None:
    """Move project_root's contents up into dest_dir so the project's own
    files end up at the path the rest of the pipeline expects (including
    anything alongside it, like a Gradle wrapper found a level deeper),
    then clean up the now-empty wrapper folders left behind.
    """
    for child in list(project_root.iterdir()):
        target = dest_dir / child.name
        if target.exists():
            if target.is_dir() and child.is_dir():
                # Merge: anything the project's own copy doesn't already
                # have, take from the wrapper level; real conflicts keep
                # whatever is already at dest_dir.
                for grandchild in child.iterdir():
                    inner_target = target / grandchild.name
                    if not inner_target.exists():
                        shutil.move(str(grandchild), str(inner_target))
                shutil.rmtree(child, ignore_errors=True)
                continue
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.move(str(child), str(target))

    # Remove the now-empty chain of wrapper folders between dest_dir and
    # where project_root used to live.
    parent = project_root
    while parent != dest_dir:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _find_anywhere(dest_dir: Path, basename: str) -> Path | None:
    """Return the first file matching basename found anywhere under
    dest_dir, not just at its conventional path — mirrors
    _locate_project_root's search so a wrapper file placed a folder or
    two deeper than expected is still picked up.
    """
    for path in dest_dir.rglob(basename):
        if path.is_file():
            return path
    return None


def validate_and_extract(zip_path: Path, dest_dir: Path) -> ExtractResult:
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise ValidationError("The archive is not a valid zip file.") from exc

    with zf:
        infos = zf.infolist()
        if not infos:
            raise ValidationError("The archive is empty.")

        has_package_json = False
        has_gradle_project = False
        skipped: list[str] = []
        to_extract: list[zipfile.ZipInfo] = []

        # Pre-scan pass: just look for a pubspec.yaml anywhere in the
        # archive, before the main validation loop below runs. This has to
        # happen first (not inline in that loop) because whether an
        # android/ or ios/ top-level folder is allowed depends on whether
        # this is a Flutter upload — and zip entries can appear in any
        # order, so the folder might be seen before pubspec.yaml is.
        has_pubspec = any(
            _PUBSPEC_RE.search(info.filename.replace("\\", "/")) for info in infos
        )

        # Same reasoning as has_pubspec above: whether android/ or ios/ at
        # the top level is allowed also depends on whether this is a React
        # Native upload, and that has to be known before the main
        # validation loop below runs (entries can appear in any order, so
        # e.g. "android/..." might be seen before package.json is). Checks
        # every package.json anywhere in the archive, not just one at the
        # eventual project root — _locate_project_root() below hasn't run
        # yet at this point, so the real root isn't known either.
        has_react_native = False
        for info in infos:
            entry_name = info.filename.replace("\\", "/")
            if _PACKAGE_JSON_RE.search(entry_name) and not entry_name.endswith("/"):
                try:
                    if _package_json_deps_include_react_native(zf.read(info)):
                        has_react_native = True
                        break
                except (KeyError, zipfile.BadZipFile):
                    continue

        for info in infos:
            entry_name = info.filename.replace("\\", "/")

            if not _is_safe_entry_name(entry_name):
                raise ValidationError(f"Unsafe path in archive: {entry_name}")

            parts = [p for p in entry_name.split("/") if p]
            top_level = parts[0].lower() if parts else ""

            top_level_is_allowed = (has_pubspec and top_level in FLUTTER_ALLOWED_TOP_LEVEL) or (
                has_react_native and top_level in REACT_NATIVE_ALLOWED_TOP_LEVEL
            )
            if top_level in FORBIDDEN_TOP_LEVEL and not top_level_is_allowed:
                raise ValidationError(
                    f'Archive already contains "{parts[0]}". Upload a plain React, React '
                    f'Native, native Android, or Flutter project — the "{parts[0]}" folder is '
                    "generated by the build."
                )

            # Search the whole archive, not just the root — some
            # uploaders zip a parent folder, a nested workspace, or a
            # multi-module repo where the actual project lives a level or
            # two down. The precise project root (shallowest match) is
            # pinned down after extraction by _locate_project_root().
            if _PACKAGE_JSON_RE.search(entry_name):
                has_package_json = True
            if _SETTINGS_GRADLE_RE.search(entry_name):
                has_gradle_project = True

            is_directory = entry_name.endswith("/")
            if is_directory:
                to_extract.append(info)
                continue

            if _is_allowed_file(entry_name):
                to_extract.append(info)
            else:
                skipped.append(entry_name)

        if not has_package_json and not has_gradle_project and not has_pubspec:
            raise ValidationError(
                "No package.json (web/Capacitor project), settings.gradle (native Android "
                "project), or pubspec.yaml (Flutter project) found anywhere in the archive."
            )

        dest_dir.mkdir(parents=True, exist_ok=True)
        for info in to_extract:
            zf.extract(info, dest_dir)

    # Locate the real project root anywhere in the extracted tree — not
    # just directly under dest_dir — and promote it up to dest_dir so the
    # project's own markers (and, for native-android, its Gradle wrapper)
    # end up where the rest of the pipeline expects them. This handles a
    # zip wrapped in one or more nested folders (a repo name, a workspace
    # folder, an extra layer, ...), not just a single top-level folder.
    project_root = _locate_project_root(dest_dir)
    if project_root is not None and project_root != dest_dir:
        _promote_project_root(dest_dir, project_root)

    # Re-check for a forbidden folder now that the real project root has
    # been promoted to dest_dir. The pre-extraction pass above only ever
    # sees the archive's literal top level, so a project nested inside a
    # wrapper folder (e.g. "myrepo/android/" alongside "myrepo/package.json")
    # would slip past it — this check is what actually matters, since it's
    # dest_dir's immediate children the build is about to write into.
    for entry in dest_dir.iterdir():
        name_lower = entry.name.lower()
        if entry.is_dir() and name_lower in FORBIDDEN_TOP_LEVEL:
            if has_pubspec and name_lower in FLUTTER_ALLOWED_TOP_LEVEL:
                continue
            if has_react_native and name_lower in REACT_NATIVE_ALLOWED_TOP_LEVEL:
                continue
            raise ValidationError(
                f'Archive already contains "{entry.name}". Upload a plain React, React Native, '
                f'native Android, or Flutter project — the "{entry.name}" folder is generated by '
                "the build."
            )

    project_type = detect_project_type(dest_dir)
    if not project_type:
        raise ValidationError(
            "Could not confirm a package.json, settings.gradle, or pubspec.yaml at the "
            "project root after extraction."
        )

    if project_type in ("native-android", "react-native"):
        # All four wrapper files are required together — 'gradlew' alone is
        # not enough. Without gradle-wrapper.jar in particular, the wrapper
        # script's own `java -classpath .../gradle-wrapper.jar
        # org.gradle.wrapper.GradleWrapperMain` line fails almost
        # immediately (a missing classpath entry isn't a Java error by
        # itself — it's simply skipped — so the *real* failure is
        # "Could not find or load main class", often with little else on
        # stdout/stderr to explain why). Catching this here, before a
        # build is ever queued, turns that into one clear message instead
        # of a confusing near-silent Gradle failure several minutes later.
        # Search the whole extracted tree for each wrapper file by name,
        # not just its conventional path — some archives place the
        # wrapper (or the whole project) a folder or two deeper than
        # dest_dir's own root markers, and a React Native project's own
        # wrapper lives under android/ rather than at the project root.
        missing_wrapper_files = [
            rel
            for basename, rel in (
                ("gradlew", "gradlew"),
                ("gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.jar"),
                ("gradle-wrapper.properties", "gradle/wrapper/gradle-wrapper.properties"),
            )
            if _find_anywhere(dest_dir, basename) is None
        ]
        if missing_wrapper_files:
            project_kind_label = "Native Android" if project_type == "native-android" else "React Native"
            wrapper_location = "the project root" if project_type == "native-android" else "its android/ folder"
            raise ValidationError(
                f"{project_kind_label} projects must include the complete Gradle wrapper in "
                f"{wrapper_location} — missing: {', '.join(missing_wrapper_files)}. All of gradlew, "
                "gradlew.bat, and gradle/wrapper/gradle-wrapper.{jar,properties} must be present "
                "(run `gradle wrapper` there and re-zip it if any are missing)."
            )

    return ExtractResult(skipped=skipped, project_type=project_type)
