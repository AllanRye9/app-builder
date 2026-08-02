"""Content-addressed node_modules cache.

Equivalent to ``src/depCache.js``.

The problem this solves: NPM_CACHE_DIR (config.py) already stops npm from
re-downloading tarballs it's fetched before, but `npm ci` still spends real
wall-clock time every single build re-extracting and re-linking the whole
dependency tree from that cache. In this service, an enormous fraction of
uploads share the exact same package-lock.json — the same React/Vite/
Capacitor starter template rebuilt over and over, or the same project
re-uploaded after a small source-code tweak that never touched
dependencies at all. For every one of those, the "install" step is pure
waste: the resulting node_modules tree is byte-for-byte identical to one
already sitting on disk from a previous job.

The fix: key a cache entry by a hash of whatever actually determines the
resulting tree (the lockfile contents, plus the Node version and the
Capacitor major this service pins — see ``fingerprint()`` below). Before
running `npm ci`, check whether that exact hash has a cached node_modules
already. If so, hardlink it straight into the project — no network, no
resolution, no extraction, just directory-tree cloning at the filesystem
level (near-instant, and consumes ~0 extra disk since hardlinks share the
underlying inodes with the cached copy).
"""
from __future__ import annotations

import functools
import hashlib
import os
import shutil
import subprocess
import time
from pathlib import Path

from .config import settings

settings.DEP_CACHE_DIR.mkdir(parents=True, exist_ok=True)


@functools.lru_cache(maxsize=1)
def _node_version() -> str:
    """process.version's equivalent: folded into the hash so a Node upgrade
    naturally invalidates old cache entries instead of silently reusing a
    tree built under different conditions. Cached for the life of the
    process — the installed Node binary doesn't change underneath a running
    container.
    """
    try:
        result = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10, check=False)
        version = result.stdout.strip()
        return version or "unknown"
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"


def fingerprint(project_dir: Path) -> str | None:
    lock_path = project_dir / "package-lock.json"
    if not lock_path.exists():
        lock_path = project_dir / "package.json"
    if not lock_path.exists():
        return None

    digest = hashlib.sha256()
    digest.update(lock_path.read_bytes())
    digest.update(f"|node:{_node_version()}".encode())
    digest.update(f"|capacitor:{os.environ.get('CAPACITOR_MAJOR', settings.CAPACITOR_MAJOR)}".encode())
    digest.update(f"|source:{lock_path.name}".encode())
    return digest.hexdigest()[:24]


def _entry_dir(hash_: str) -> Path:
    return settings.DEP_CACHE_DIR / hash_


def _entry_modules_dir(hash_: str) -> Path:
    return _entry_dir(hash_) / "node_modules"


def _hardlink_tree(src: Path, dest: Path) -> bool:
    """Hardlinks every file in ``src`` into ``dest`` instead of copying
    bytes — a multi-hundred-MB node_modules tree restores in a fraction of
    a second and costs ~0 additional disk, since both the cache entry and
    the project's copy point at the same inodes. Falls back to a real
    recursive copy (slower, but still far cheaper than a full npm ci) if
    hardlinking fails for any reason (e.g. cache and project live on
    different filesystems/devices).
    """
    try:
        shutil.copytree(src, dest, copy_function=os.link)
        return True
    except (OSError, shutil.Error):
        shutil.rmtree(dest, ignore_errors=True)
        try:
            shutil.copytree(src, dest)
            return True
        except (OSError, shutil.Error):
            return False


def restore(hash_: str, project_dir: Path) -> bool:
    """Returns True if a cached node_modules for this hash was found and
    linked into project_dir/node_modules — the caller can then skip
    `npm ci` entirely.
    """
    src = _entry_modules_dir(hash_)
    if not src.exists():
        return False

    dest = project_dir / "node_modules"
    shutil.rmtree(dest, ignore_errors=True)
    ok = _hardlink_tree(src, dest)
    if ok:
        _touch(hash_)
    return ok


def save(hash_: str, project_dir: Path) -> bool:
    """Called after a real `npm ci`/`npm install` succeeds, to make that
    result available to the next job that hashes the same lockfile. Writes
    to a staging dir first and renames into place, so a build that crashes
    mid-save (or two jobs finishing the same hash concurrently) can never
    leave a half-written, corrupt cache entry for the next job to hardlink
    from.
    """
    src = project_dir / "node_modules"
    if not src.exists():
        return False

    entry_dir = _entry_dir(hash_)
    staging = entry_dir.with_name(f"{entry_dir.name}.staging-{os.getpid()}-{int(time.time() * 1000)}")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    ok = _hardlink_tree(src, staging / "node_modules")
    if not ok:
        shutil.rmtree(staging, ignore_errors=True)
        return False

    shutil.rmtree(entry_dir, ignore_errors=True)
    staging.rename(entry_dir)
    _touch(hash_)
    _evict_oldest()
    return True


def _touch(hash_: str) -> None:
    try:
        now = time.time()
        os.utime(_entry_dir(hash_), (now, now))
    except OSError:
        # Entry may not exist yet on a fresh save() — harmless, save() sets
        # its own mtime implicitly by creating the directory just after.
        pass


def _evict_oldest() -> None:
    """Simple LRU by directory mtime — good enough at this scale (single
    digit to low tens of entries) without needing a separate metadata file
    to keep in sync.
    """
    try:
        entries = [
            (p, p.stat().st_mtime)
            for p in settings.DEP_CACHE_DIR.iterdir()
            if p.is_dir() and ".staging-" not in p.name
        ]
    except OSError:
        return
    if len(entries) <= settings.DEP_CACHE_MAX_ENTRIES:
        return
    entries.sort(key=lambda e: e[1])
    for path, _mtime in entries[: len(entries) - settings.DEP_CACHE_MAX_ENTRIES]:
        shutil.rmtree(path, ignore_errors=True)
