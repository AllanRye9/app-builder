"""Archive validation, extraction, and project-type detection.

Equivalent to ``src/validate.js``, using the standard-library ``zipfile``
module in place of ``adm-zip``.
"""
from __future__ import annotations

import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


class ValidationError(Exception):
    pass


# android/, ios/, and platforms/ are genuinely generated output — an
# existing one would collide with what the build creates and can't be
# safely merged, so those still hard-reject. A capacitor.config.json/.ts by
# itself is different: plenty of real Capacitor-ready projects ship one
# deliberately, and build_runner.py detects it and reuses it instead of
# overwriting it via `cap init`, rather than rejecting it here.
FORBIDDEN_TOP_LEVEL = frozenset({"android", "ios", "platforms"})

# Only these file types are trusted to build the app itself. Anything else
# in the archive (editor/OS cruft, license files, whatever) is simply
# skipped rather than failing the whole upload — none of it is needed to
# build the APK.
#
# Covers both project kinds this builder accepts:
#  - a web project (React/Vite/etc.) wrapped into Android via Capacitor
#  - a native Android project written in Kotlin and/or Java, built with its
#    own Gradle project directly (no Capacitor/web step at all)
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
    """A project is buildable one of two ways, decided purely by what it
    contains — never by a flag the uploader has to set:
      - 'capacitor-web': a package.json at the root (React/Vite/etc.),
        wrapped into an Android shell via Capacitor at build time.
      - 'native-android': a Gradle project at the root
        (settings.gradle(.kts) + a root build.gradle(.kts)) with no
        wrapping needed — its own gradlew builds the APK directly.
    """
    if (dest_dir / "package.json").exists():
        return "capacitor-web"
    has_settings_gradle = (dest_dir / "settings.gradle").exists() or (dest_dir / "settings.gradle.kts").exists()
    has_root_build_gradle = (dest_dir / "build.gradle").exists() or (dest_dir / "build.gradle.kts").exists()
    if has_settings_gradle and has_root_build_gradle:
        return "native-android"
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

        for info in infos:
            entry_name = info.filename.replace("\\", "/")

            if not _is_safe_entry_name(entry_name):
                raise ValidationError(f"Unsafe path in archive: {entry_name}")

            parts = [p for p in entry_name.split("/") if p]
            top_level = parts[0].lower() if parts else ""

            if top_level in FORBIDDEN_TOP_LEVEL:
                raise ValidationError(
                    f'Archive already contains "{parts[0]}". Upload a plain React (or native '
                    f'Android) project — the "{parts[0]}" folder is generated by the build.'
                )

            # Only trust these markers at the project root (depth 0, or
            # depth 1 if the whole zip is wrapped in a single top folder —
            # flattened below).
            at_root_depth = len(parts) <= 2
            if at_root_depth and _PACKAGE_JSON_RE.search(entry_name):
                has_package_json = True
            if at_root_depth and _SETTINGS_GRADLE_RE.search(entry_name):
                has_gradle_project = True

            is_directory = entry_name.endswith("/")
            if is_directory:
                to_extract.append(info)
                continue

            if _is_allowed_file(entry_name):
                to_extract.append(info)
            else:
                skipped.append(entry_name)

        if not has_package_json and not has_gradle_project:
            raise ValidationError(
                "No package.json (web/Capacitor project) or settings.gradle (native Android "
                "project) found at the project root."
            )

        dest_dir.mkdir(parents=True, exist_ok=True)
        for info in to_extract:
            zf.extract(info, dest_dir)

    # If the zip wrapped everything in a single top-level folder, flatten it
    # so the project's own root markers end up directly inside dest_dir.
    root_entries = list(dest_dir.iterdir())
    if len(root_entries) == 1:
        only_path = root_entries[0]
        looks_like_project_root = only_path.is_dir() and (
            (only_path / "package.json").exists()
            or (only_path / "settings.gradle").exists()
            or (only_path / "settings.gradle.kts").exists()
        )
        if looks_like_project_root:
            for child in only_path.iterdir():
                child.rename(dest_dir / child.name)
            shutil.rmtree(only_path, ignore_errors=True)

    project_type = detect_project_type(dest_dir)
    if not project_type:
        raise ValidationError(
            "Could not confirm a package.json or settings.gradle at the project root after extraction."
        )

    if project_type == "native-android":
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
        missing_wrapper_files = [
            rel
            for rel in ("gradlew", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties")
            if not (dest_dir / rel).exists()
        ]
        if missing_wrapper_files:
            raise ValidationError(
                "Native Android projects must include the complete Gradle wrapper — missing: "
                f"{', '.join(missing_wrapper_files)}. All of gradlew, gradlew.bat, and "
                "gradle/wrapper/gradle-wrapper.{jar,properties} must be present (run `gradle "
                "wrapper` in your project and re-zip it if any are missing)."
            )

    return ExtractResult(skipped=skipped, project_type=project_type)
