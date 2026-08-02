"""Central configuration, all overridable via environment variables.

Mirrors the original ``src/config.js`` 1:1 — same variable names, same
defaults, same rationale. Kept as a single frozen dataclass instantiated
once at import time so every module shares one source of truth, the same
role ``config.js``'s ``module.exports`` object played.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_str(name: str, default: str) -> str:
    return os.environ.get(name) or default


@dataclass(frozen=True)
class Settings:
    # Most platforms inject PORT themselves — the app must listen on
    # whatever it sets. Falls back to 8000 for local/bare use.
    PORT: int = field(default_factory=lambda: _env_int("PORT", 8000))

    # Builds share this one container's CPU/RAM directly. Default is
    # deliberately conservative — Gradle + the Android Gradle Plugin alone
    # can use 1.5-2.5GB per concurrent build, on top of whatever the API
    # server itself needs. Size this against your host/plan's actual RAM,
    # not against how many CPU cores it has.
    MAX_CONCURRENT_BUILDS: int = field(default_factory=lambda: _env_int("MAX_CONCURRENT_BUILDS", 2))

    BUILD_TIMEOUT_MS: int = field(default_factory=lambda: _env_int("BUILD_TIMEOUT_MS", 15 * 60 * 1000))
    MAX_UPLOAD_BYTES: int = field(default_factory=lambda: _env_int("MAX_UPLOAD_BYTES", 300 * 1024 * 1024))

    JOB_ROOT: Path = field(
        default_factory=lambda: Path(os.environ.get("JOB_ROOT") or Path(tempfile.gettempdir()) / "apk-builder-jobs")
    )
    JOB_TTL_MS: int = field(default_factory=lambda: _env_int("JOB_TTL_MS", 60 * 60 * 1000))

    # Frontend and API are served from this same service by default, so
    # cross-origin requests aren't the normal case here — kept available in
    # case the frontend is ever split out separately.
    CORS_ORIGIN: str = field(default_factory=lambda: _env_str("CORS_ORIGIN", "*"))

    RATE_LIMIT_MAX: int = field(default_factory=lambda: _env_int("RATE_LIMIT_MAX", 10))
    RATE_LIMIT_WINDOW_MS: int = field(default_factory=lambda: _env_int("RATE_LIMIT_WINDOW_MS", 10 * 60 * 1000))

    # Deliberately OUTSIDE JOB_ROOT (which per-job dirs live under and get
    # wiped by purge_job/the TTL sweep) — shared across every job for as
    # long as the container lives. Without them, every single build
    # re-downloads the full Gradle distribution + every npm dependency from
    # scratch, even though back-to-back builds in the same container almost
    # always want the same handful of packages.
    NPM_CACHE_DIR: Path = field(
        default_factory=lambda: Path(
            os.environ.get("NPM_CACHE_DIR") or Path(tempfile.gettempdir()) / "apk-builder-cache" / "npm"
        )
    )

    # NOTE: intentionally NOT used as GRADLE_USER_HOME — see build_runner.py
    # for the full "daemon registry vs dependency cache" rationale. This is
    # the shared, persistent, read-only reuse of downloaded module/artifact
    # caches + wrapper distributions across every job.
    GRADLE_RO_DEP_CACHE: Path = field(
        default_factory=lambda: Path(
            os.environ.get("GRADLE_RO_DEP_CACHE")
            or Path(tempfile.gettempdir()) / "apk-builder-cache" / "gradle-ro-cache"
        )
    )

    # Gradle's *local build cache* (what --build-cache populates) — a
    # separate thing from the dependency cache above, but just as safe to
    # share across concurrent jobs. See app/shared-build-cache-init.gradle.
    GRADLE_SHARED_BUILD_CACHE_DIR: Path = field(
        default_factory=lambda: Path(
            os.environ.get("GRADLE_SHARED_BUILD_CACHE_DIR")
            or Path(tempfile.gettempdir()) / "apk-builder-cache" / "gradle-build-cache"
        )
    )

    # Shared, persistent cache of fully-resolved node_modules trees, keyed
    # by a hash of package-lock.json (+ a few env fingerprints) — see
    # app/dep_cache.py.
    DEP_CACHE_DIR: Path = field(
        default_factory=lambda: Path(
            os.environ.get("DEP_CACHE_DIR")
            or Path(tempfile.gettempdir()) / "apk-builder-cache" / "node-modules-cache"
        )
    )
    # Bounds disk usage: oldest-used cache entries are evicted once this
    # many distinct lockfile hashes have accumulated.
    DEP_CACHE_MAX_ENTRIES: int = field(default_factory=lambda: _env_int("DEP_CACHE_MAX_ENTRIES", 8))

    # Real OOM prevention, not just a job-count ceiling — see
    # build_runner.py's pump().
    MIN_FREE_MEMORY_MB: int = field(default_factory=lambda: _env_int("MIN_FREE_MEMORY_MB", 512))

    APP_ID: str = field(default_factory=lambda: _env_str("APP_ID", "com.builder.app"))
    APP_NAME: str = field(default_factory=lambda: _env_str("APP_NAME", "MyApp"))
    CAPACITOR_MAJOR: str = field(default_factory=lambda: _env_str("CAPACITOR_MAJOR", "7"))

    @property
    def cors_origins(self) -> list[str]:
        if self.CORS_ORIGIN == "*":
            return ["*"]
        return [o.strip() for o in self.CORS_ORIGIN.split(",") if o.strip()]


settings = Settings()
