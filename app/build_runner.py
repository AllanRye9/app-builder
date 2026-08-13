"""Build queue, admission control, and the actual build pipeline.

Equivalent to ``src/buildRunner.js``. Builds run as direct asyncio
subprocesses in this same container/process — no Docker-in-Docker, no
sibling containers — exactly like the original.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import signal
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import psutil

from . import dep_cache
from .config import settings
from .job_store import Job, log, notice, set_paused, set_queue_position, set_status, set_step

SHARED_BUILD_CACHE_INIT_SCRIPT = Path(__file__).with_name("shared-build-cache-init.gradle")


class BuildCancelled(RuntimeError):
    """Raised inside a build when the user pressed Stop — as opposed to a
    genuine build failure. Kept as its own exception type so `_run_build`
    can route it to the distinct 'stopped' status instead of 'failed'.
    """


class CommandFailed(RuntimeError):
    """A command exited with a non-zero code. Carries that code separately
    from the human-readable message so the job store / API / frontend can
    all key off the number itself (badges, exit-code-specific troubleshoot
    tips) without re-parsing it back out of a free-text string.
    """

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def _normalize_exit_code(code: int) -> int:
    """Python/asyncio reports a signal-terminated process as a *negative*
    return code — e.g. -9 for SIGKILL — because these commands are run via
    create_subprocess_exec() with no intervening shell (see run() below);
    a shell would instead report the far more widely recognized 128+N
    convention (137, 143, ...) that _describe_exit_code() below expects
    and that people actually search for. Normalized once here, at the one
    place a raw process return code enters the system, so job.exit_code,
    the log line, the API response, and the assistant panel all agree.
    """
    if code < 0:
        return 128 - code
    return code


def _describe_exit_code(code: int) -> str:
    """Best-effort human explanation for a process's exit code — covers
    the handful of conventional ranges every build tool ultimately exits
    through, not just Gradle/npm's own usual '1':
      - 0 is never passed in here (that's success).
      - 1/2: generic tool-reported failure / bad invocation.
      - 126/127: found-but-not-executable / not-found-on-PATH — almost
        always an environment problem, not the project's own code.
      - 128+N: the process was killed by signal N (128+9=137 is by far
        the most common one seen here — either the container's OOM killer
        or this app's own Stop button, both of which send SIGKILL).
      - 64-78: the BSD sysexits.h range — some CLIs (and quite a few
        Node/Python tools that follow the same convention) use these for
        specific, structured failure categories rather than a bare '1'.
    """
    if code == 1:
        return "general error — the tool reported a normal failure; see the log above for the specific message"
    if code == 2:
        return "misuse of the command — usually a bad/unsupported argument was passed to it"
    if code == 126:
        return "found but not executable — check the file's permissions (needs chmod +x) or that it isn't a directory"
    if code == 127:
        return "command not found — a required executable is missing from PATH inside the build container"
    if 128 < code <= 165:
        sig_num = code - 128
        try:
            sig_name = signal.Signals(sig_num).name
        except ValueError:
            sig_name = f"signal {sig_num}"
        if sig_num == signal.SIGKILL:
            return f"killed by {sig_name} — most often the container's out-of-memory killer, or the build was stopped"
        if sig_num == signal.SIGTERM:
            return f"terminated by {sig_name} — the process was asked to shut down"
        if sig_num == signal.SIGABRT:
            return f"aborted ({sig_name}) — often a native/JVM crash rather than a normal build error"
        return f"terminated by {sig_name}"
    sysexits = {
        64: "command line usage error",
        65: "data format error — malformed input was fed to the tool (e.g. an invalid config/manifest file)",
        66: "cannot open input — a required input file was missing or unreadable",
        67: "addressee unknown",
        68: "host unknown",
        69: "service unavailable",
        70: "internal software error in the tool itself",
        71: "operating system error",
        72: "a critical OS file is missing",
        73: "can't create the output file — check disk space/permissions",
        74: "input/output error while reading or writing a file",
        75: "temporary failure — worth simply retrying",
        76: "remote protocol error",
        77: "permission denied",
        78: "configuration error",
    }
    if code in sysexits:
        return sysexits[code]
    return "non-zero exit — see the log above for the tool's own error output"

APP_ID = os.environ.get("APP_ID", settings.APP_ID)
APP_NAME = os.environ.get("APP_NAME", settings.APP_NAME)
CAPACITOR_MAJOR = os.environ.get("CAPACITOR_MAJOR", settings.CAPACITOR_MAJOR)
FLUTTER_BUILD_MODE = os.environ.get("FLUTTER_BUILD_MODE", settings.FLUTTER_BUILD_MODE)

# Created once at import time, shared by every job for the life of this
# process — see config.py for why these live outside JOB_ROOT.
settings.NPM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
settings.GRADLE_RO_DEP_CACHE.mkdir(parents=True, exist_ok=True)
settings.GRADLE_SHARED_BUILD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
settings.GRADLE_DIST_CACHE_DIR.mkdir(parents=True, exist_ok=True)
settings.PUB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
# Gradle's shared read-only dependency cache refuses to activate unless this
# exact subdirectory already exists — otherwise every build logs "Read-only
# cache is configured but the directory layout isn't expected" and silently
# falls back to a normal (unshared) cache. Pre-creating it once here is
# enough; Gradle populates its contents itself on first use.
(settings.GRADLE_RO_DEP_CACHE / "modules-2").mkdir(parents=True, exist_ok=True)

# Per-build Gradle JVM heap cap, sized against this container's *actual*
# total RAM rather than a fixed guess — see config.py's MIN_FREE_MEMORY_MB
# note. Reserve headroom for the server itself and the OS, split the rest
# evenly across the concurrency budget, and clamp to a sane range.
#
# The reservation itself scales with total RAM instead of a flat constant:
# a fixed 512MB reservation is proportionally huge on a small 1-2GB
# instance (eating most of the per-slot budget before any build even
# starts) and needlessly conservative on a large one (leaving RAM on the
# table that could have gone to a bigger heap). _RESERVED_PERCENT_MB below
# is a floor/ceiling-clamped percentage of total RAM instead.
_RESERVED_PERCENT = 0.20
_MIN_RESERVED_MB = 384
_MAX_RESERVED_MB = 1024
_MIN_BUILD_HEAP_MB = 768
_MAX_BUILD_HEAP_MB = 2048
_TOTAL_MB = psutil.virtual_memory().total / 1024 / 1024
_RESERVED_MB = max(_MIN_RESERVED_MB, min(_MAX_RESERVED_MB, int(_TOTAL_MB * _RESERVED_PERCENT)))
_PER_SLOT_MB = (_TOTAL_MB - _RESERVED_MB) / max(settings.MAX_CONCURRENT_BUILDS, 1)
GRADLE_HEAP_MB = max(
    _MIN_BUILD_HEAP_MB,
    min(_MAX_BUILD_HEAP_MB, int(_PER_SLOT_MB)),
)

# Cap for the Node process running a Capacitor-web job's `npm ci`/`npm run
# build`/`npx cap ...` steps — previously the *only* build path with no
# heap ceiling at all (Gradle gets GRADLE_HEAP_MB, Flutter's Dart VM gets
# FLUTTER_DART_HEAP_MB below), even though a bundler compiling a large web
# project with source maps can spike memory just as hard as a JVM. Reuses
# the same per-slot budget GRADLE_HEAP_MB draws from — safe to size
# identically rather than needing its own split, since a Capacitor job's
# npm steps and its `gradlew` invocation run sequentially within the same
# job, never concurrently, so they're never actually claiming their heap
# caps against this slot's budget at the same instant.
NODE_HEAP_MB = GRADLE_HEAP_MB

# A Flutter build is NOT one JVM per slot the way native-android/Capacitor
# builds are — `flutter build apk` runs its own Dart VM (frontend_server /
# kernel + AOT compilation) *and* drives an embedded Gradle JVM for the
# android/ project, both alive at once. Handing a Flutter job the same
# full GRADLE_HEAP_MB on top of an otherwise-uncapped Dart VM means one
# build slot can claim two full-sized processes' worth of RAM — this is
# the main driver of this container's "huge memory utilization" under
# Flutter builds. Instead, split the same per-slot budget GRADLE_HEAP_MB
# is drawn from across the two processes so a Flutter job stays inside
# roughly the same envelope as any other job. The Gradle side gets the
# smaller share since, for a Flutter project, its embedded Gradle
# invocation only packages an already-compiled app (no Kotlin/Java
# app-module compilation of its own to speak of) — the Dart VM is doing
# the heavy lifting.
_MIN_FLUTTER_GRADLE_HEAP_MB = 384
_MAX_FLUTTER_GRADLE_HEAP_MB = 1024
_MIN_FLUTTER_DART_HEAP_MB = 512
_MAX_FLUTTER_DART_HEAP_MB = 1536
FLUTTER_GRADLE_HEAP_MB = max(
    _MIN_FLUTTER_GRADLE_HEAP_MB,
    min(_MAX_FLUTTER_GRADLE_HEAP_MB, int(_PER_SLOT_MB * 0.4)),
)
FLUTTER_DART_HEAP_MB = max(
    _MIN_FLUTTER_DART_HEAP_MB,
    min(_MAX_FLUTTER_DART_HEAP_MB, int(_PER_SLOT_MB * 0.6)),
)

_queue: list[Job] = []
_running = 0
_memory_recheck_scheduled = False

# Every currently-running build's live control surface, keyed by job id —
# how pause_job()/resume_job()/cancel_job() below (called from the
# pause/resume/cancel API routes) find the actual OS process to signal.
# Populated when a build starts running, removed the moment it finishes —
# a job with no entry here is either still queued or already terminal.
_contexts: dict[str, "_BuildContext"] = {}

# Used when searching for *source* files (AndroidManifest.xml) — dependency
# caches and Gradle's own intermediate build output are never what we want.
_SOURCE_SEARCH_SKIP_DIRS = frozenset({"node_modules", ".git", "build", ".gradle", ".idea"})
# Used when searching for the *built APK* — 'build' must NOT be skipped
# here, since build/outputs/apk/debug/ is exactly where it lives.
_OUTPUT_SEARCH_SKIP_DIRS = frozenset({"node_modules", ".git", ".gradle", ".idea"})

_MANIFEST_TAG_RE = re.compile(r"<manifest([^>]*)>")


def enqueue(job: Job) -> None:
    _queue.append(job)
    _pump()
    _broadcast_queue_positions()


def get_build_counts() -> dict[str, int]:
    return {"running": _running, "queued": len(_queue)}


def _remove_from_queue(job_id: str) -> Job | None:
    for i, job in enumerate(_queue):
        if job.id == job_id:
            return _queue.pop(i)
    return None


async def pause_job(job_id: str) -> tuple[bool, str]:
    """Suspends (SIGSTOP) every process a running build has spawned, in
    place — genuinely pausing compilation rather than killing and later
    re-running it. Only meaningful for a build that's actually running.
    """
    ctx = _contexts.get(job_id)
    if ctx is None:
        return False, "This build isn't currently running (it may be queued, or already finished)."
    return await ctx.pause()


async def resume_job(job_id: str) -> tuple[bool, str]:
    """Resumes (SIGCONT) a build previously paused with pause_job() —
    the same subprocess picks up exactly where it was suspended."""
    ctx = _contexts.get(job_id)
    if ctx is None:
        return False, "This build isn't currently running."
    return await ctx.resume()


async def cancel_job(job_id: str) -> tuple[bool, str]:
    """Stops a build outright: kills every process of a running build, or
    simply removes a not-yet-started build from the queue. Distinct from
    pause_job() — there's no picking this back up; see routes.py's
    /rebuild endpoint for re-running the job from scratch afterward.
    """
    ctx = _contexts.get(job_id)
    if ctx is not None:
        return await ctx.cancel()

    job = _remove_from_queue(job_id)
    if job is not None:
        set_status(job, "stopped", "Cancelled while waiting in the queue.")
        log(job, "Build cancelled by user while still queued.")
        _broadcast_queue_positions()
        return True, "Removed from the queue."

    return False, "This build isn't currently running or queued."


def _broadcast_queue_positions() -> None:
    for i, job in enumerate(_queue):
        set_queue_position(job, i + 1)


def _free_mem_mb() -> float:
    return psutil.virtual_memory().available / 1024 / 1024


def _pump() -> None:
    global _running
    while _running < settings.MAX_CONCURRENT_BUILDS and _queue:
        # Real OOM guard, independent of the concurrency count above.
        # Checked fresh every loop iteration because starting one job
        # changes how much memory is available for the next.
        if _free_mem_mb() < settings.MIN_FREE_MEMORY_MB:
            job = _queue[0]
            log(
                job,
                f"Waiting for available memory before starting "
                f"({round(_free_mem_mb())}MB free, need {settings.MIN_FREE_MEMORY_MB}MB).",
            )
            _schedule_memory_recheck()
            break

        job = _queue.pop(0)
        _running += 1
        set_queue_position(job, 0)
        task = asyncio.create_task(_run_build(job))
        task.add_done_callback(_on_build_finished)


def _on_build_finished(_task: asyncio.Task) -> None:
    global _running
    _running -= 1
    _pump()
    _broadcast_queue_positions()


def _schedule_memory_recheck() -> None:
    global _memory_recheck_scheduled
    if _memory_recheck_scheduled:
        return
    _memory_recheck_scheduled = True

    async def _recheck() -> None:
        global _memory_recheck_scheduled
        await asyncio.sleep(5)
        _memory_recheck_scheduled = False
        _pump()

    asyncio.create_task(_recheck())


def _detect_web_dir(project_dir: Path) -> str | None:
    for name in ("dist", "build", "www", "out"):
        candidate = project_dir / name
        if candidate.is_dir():
            return name
    return None


def _find_files_recursive(root_dir: Path, match_fn: Callable[[str], bool], skip_dirs: frozenset[str]) -> list[Path]:
    """Depth-first search for files matching ``match_fn``, skipping
    directories in ``skip_dirs`` — callers pass different skip lists
    because "build/" means two different things here: for finding a
    *source* AndroidManifest.xml it's noise to avoid, but for finding the
    *APK* it's the only place the file will ever exist.
    """
    results: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for filename in filenames:
            if match_fn(filename):
                results.append(Path(dirpath) / filename)
    return results


def _patch_manifest_permissions(job: Job, manifest_path: Path) -> None:
    """Adds ONLY the permissions the uploader actually asked for
    (job.permissions — already validated against a whitelist in
    app/permissions.py) to the given manifest. Never invents permissions on
    its own: an upload with no requested permissions leaves the manifest
    byte-for-byte as the uploader wrote it.
    """
    if not job.permissions:
        return
    if not manifest_path.exists():
        log(job, f"Requested permissions but no AndroidManifest.xml was found at {manifest_path} to add them to.")
        return

    xml = manifest_path.read_text(encoding="utf-8")
    missing = [p for p in job.permissions if f'"{p}"' not in xml]
    if not missing:
        log(job, "All requested permissions were already declared in AndroidManifest.xml.")
        return

    inserted = "\n".join(f'    <uses-permission android:name="{p}" />' for p in missing)

    def _inject(match: re.Match) -> str:
        return f"<manifest{match.group(1)}>\n{inserted}"

    patched = _MANIFEST_TAG_RE.sub(_inject, xml, count=1)
    manifest_path.write_text(patched, encoding="utf-8")

    log(job, f"Added requested permission(s) to AndroidManifest.xml: {', '.join(missing)}")
    notice(
        job,
        level="info",
        title="Applied requested permissions",
        message=f"Added to AndroidManifest.xml: {', '.join(missing)}.",
    )


class _BuildContext:
    """Per-build mutable state (the current subprocess, timeout flag) that
    the JS original captured via closures over ``runBuild``'s local
    variables. Kept as an object here for the same reason: multiple builds
    run concurrently, each needs its own isolated state.
    """

    def __init__(self, job: Job) -> None:
        self.job = job
        self.current_process: asyncio.subprocess.Process | None = None
        self.timed_out = False
        self.timeout_task: asyncio.Task | None = None
        # Pause/resume state — see pause()/resume() below. `paused` is the
        # live flag; `pause_started_at`/`total_paused_s` let the timeout
        # watchdog subtract paused time from its own countdown, so a build
        # someone stepped away from mid-pause doesn't get killed the
        # instant it's resumed just because the wall-clock timer expired
        # while it was legitimately suspended.
        self.paused = False
        self.pause_started_at: float | None = None
        self.total_paused_s = 0.0
        self.cancelled = False

    def _pgid(self) -> int | None:
        if self.current_process is None:
            return None
        try:
            return os.getpgid(self.current_process.pid)
        except ProcessLookupError:
            return None

    async def _timeout_watchdog(self) -> None:
        # Ticks in small increments rather than one long sleep, so it can
        # simply not count time spent paused — a build paused for longer
        # than BUILD_TIMEOUT_MS must not be killed the moment it's
        # resumed, since from the uploader's perspective no build time
        # actually elapsed while it was suspended.
        timeout_s = settings.BUILD_TIMEOUT_MS / 1000
        tick_s = 1.0
        active_elapsed = 0.0
        while active_elapsed < timeout_s:
            await asyncio.sleep(tick_s)
            if not self.paused:
                active_elapsed += tick_s
        self.timed_out = True
        pgid = self._pgid()
        if pgid is not None:
            # Kill the whole process group, not just the immediate child —
            # Gradle forks its own JVM worker processes even with
            # --no-daemon; killing only the wrapper script would leave
            # those orphaned instead of terminated. Wake it first in case
            # it's currently paused — SIGKILL is not deliverable to a
            # stopped process on some platforms until it's continued.
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGCONT)
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGKILL)

    def start_watchdog(self) -> None:
        self.timeout_task = asyncio.create_task(self._timeout_watchdog())

    def cancel_watchdog(self) -> None:
        if self.timeout_task is not None:
            self.timeout_task.cancel()

    async def pause(self) -> tuple[bool, str]:
        if self.paused:
            return False, "This build is already paused."
        pgid = self._pgid()
        if pgid is None:
            return False, "No active build process to pause right now (it's between commands)."
        try:
            os.killpg(pgid, signal.SIGSTOP)
        except (ProcessLookupError, PermissionError) as exc:
            return False, f"Couldn't pause the build: {exc}"
        self.paused = True
        self.pause_started_at = time.monotonic()
        set_paused(self.job, True)
        log(self.job, "⏸ Build paused by user — the running process is suspended, not killed.")
        return True, "Build paused."

    async def resume(self) -> tuple[bool, str]:
        if not self.paused:
            return False, "This build isn't paused."
        pgid = self._pgid()
        if pgid is None:
            # The process is gone (finished or was killed) while paused —
            # nothing left to resume.
            self.paused = False
            set_paused(self.job, False)
            return False, "The paused build process is no longer running."
        try:
            os.killpg(pgid, signal.SIGCONT)
        except (ProcessLookupError, PermissionError) as exc:
            return False, f"Couldn't resume the build: {exc}"
        if self.pause_started_at is not None:
            self.total_paused_s += time.monotonic() - self.pause_started_at
            self.pause_started_at = None
        self.paused = False
        set_paused(self.job, False)
        log(self.job, "▶ Build resumed by user.")
        return True, "Build resumed."

    async def cancel(self) -> tuple[bool, str]:
        self.cancelled = True
        pgid = self._pgid()
        if pgid is not None:
            # Wake it up first (SIGKILL isn't deliverable to a stopped
            # process on every platform until it's continued), then kill
            # the whole process group so nothing forked survives.
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGCONT)
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGKILL)
        if self.paused:
            self.paused = False
            set_paused(self.job, False)
        log(self.job, "■ Build stopped by user.")
        return True, "Build stopping."

    async def run(self, command: str, args: list[str], *, cwd: Path | None = None) -> None:
        """Runs one command to completion, streaming its output into the
        job log line-by-line as it happens — this is what the frontend's
        live log view is actually watching.
        """
        job = self.job
        log(job, f"$ {command} {' '.join(args)}")

        # This server's own process may have NODE_ENV=production set — but
        # that must NOT leak into the uploaded project's own npm
        # install/build. npm can treat NODE_ENV=production as "skip
        # devDependencies", and a project's build tool (vite,
        # react-scripts, webpack-cli, ...) almost always lives in
        # devDependencies. Deleting NODE_ENV here is defense in depth; the
        # actual fix is forcing --include=dev on the install/ci call (see
        # the call site).
        child_env = dict(os.environ)
        child_env.pop("NODE_ENV", None)

        # Shared, persistent npm cache — set unconditionally. Harmless for
        # commands that don't read it, and means npm never re-fetches a
        # dependency this container has already downloaded for a previous
        # job.
        child_env["NPM_CONFIG_CACHE"] = str(settings.NPM_CACHE_DIR)

        # Same idea, for Flutter/Dart's own package manager — set
        # unconditionally too; only `flutter`/`dart pub` invocations ever
        # read it. See config.py's PUB_CACHE_DIR for why this doesn't need
        # its own hardlink/eviction layer the way DEP_CACHE_DIR does.
        child_env["PUB_CACHE"] = str(settings.PUB_CACHE_DIR)

        # Gradle's cache and its daemon registry are DIFFERENT things and
        # must NOT share a directory across concurrent jobs — sharing
        # GRADLE_USER_HOME across concurrent builds produces an endless
        # "Unexpected type tag N found" / "Discarding connection" loop
        # instead of a real error, because each build's daemon registry
        # collides with the others'.
        #
        # GRADLE_USER_HOME here is per-job (wiped by the same TTL sweep as
        # the rest of the job) so each build's daemon registry is isolated.
        # GRADLE_RO_DEP_CACHE is shared and read-only, so downloaded
        # module/artifact caches + wrapper distributions still get reused
        # across jobs.
        job_gradle_home = job.dir / "gradle-home"
        job_gradle_home.mkdir(parents=True, exist_ok=True)

        # Share the wrapper's distribution cache (the actual gradle-X-bin.zip
        # download + its unpacked contents) across every job, even though
        # GRADLE_USER_HOME itself stays per-job. This only touches the one
        # subdirectory that's safe to share (see GRADLE_DIST_CACHE_DIR in
        # config.py) — daemon/, native/, etc. all stay isolated under
        # job_gradle_home exactly as before. Symlinked once per job rather
        # than per build() call, so this is a no-op on every command after
        # the first for a given job.
        wrapper_dir = job_gradle_home / "wrapper"
        wrapper_dir.mkdir(parents=True, exist_ok=True)
        dists_link = wrapper_dir / "dists"
        if not dists_link.exists() and not dists_link.is_symlink():
            dists_link.symlink_to(settings.GRADLE_DIST_CACHE_DIR, target_is_directory=True)

        child_env["GRADLE_USER_HOME"] = str(job_gradle_home)
        child_env["GRADLE_RO_DEP_CACHE"] = str(settings.GRADLE_RO_DEP_CACHE)
        child_env["GRADLE_SHARED_BUILD_CACHE_DIR"] = str(settings.GRADLE_SHARED_BUILD_CACHE_DIR)

        # IMPORTANT: this must go through GRADLE_OPTS, not
        # JAVA_TOOL_OPTIONS. gradlew's own wrapper script reads GRADLE_OPTS
        # directly and folds it into the literal `java ...` command line it
        # launches itself with, so these settings are part of that JVM's
        # real input arguments from the start — nothing left for Gradle to
        # "fix" by forking a second (single-use) daemon JVM, which is what
        # causes the same IPv4/IPv6 loopback-mismatch socket loop as the
        # daemon-registry collision above. Caps how much heap any single
        # JVM this build spawns can claim, sized against this container's
        # real total RAM and MAX_CONCURRENT_BUILDS (see GRADLE_HEAP_MB
        # above). Harmless to set unconditionally on every spawned command
        # (npm/npx included) — those simply never read GRADLE_OPTS.
        is_flutter_job = job.project_type == "flutter"
        gradle_heap_mb = FLUTTER_GRADLE_HEAP_MB if is_flutter_job else GRADLE_HEAP_MB
        gradle_jvm_args = f"-Xmx{gradle_heap_mb}m -Djava.net.preferIPv4Stack=true"
        child_env["GRADLE_OPTS"] = " ".join(filter(None, [child_env.get("GRADLE_OPTS"), gradle_jvm_args]))
        child_env.pop("JAVA_TOOL_OPTIONS", None)

        if is_flutter_job:
            # Caps the Dart VM's old-space heap (frontend_server, the
            # kernel compiler, and `flutter`/`dart` itself all run on this
            # VM) the same way GRADLE_OPTS caps the JVM above. Read by
            # every `flutter`/`dart` invocation this job makes (pub get,
            # create, build) — harmless to set for the lighter-weight
            # early steps too, since they use far less memory than the
            # actual `build apk` compile.
            dart_vm_args = f"--old_gen_heap_size={FLUTTER_DART_HEAP_MB}"
            child_env["DART_VM_OPTIONS"] = " ".join(filter(None, [child_env.get("DART_VM_OPTIONS"), dart_vm_args]))

        # Caps the V8 heap for `npm`/`npx` themselves and whatever bundler
        # they invoke (vite/webpack/react-scripts/...) — see NODE_HEAP_MB
        # above. Previously the one build path (Capacitor-web) with no
        # heap ceiling at all, unlike Gradle/Dart. Set unconditionally, the
        # same way GRADLE_OPTS is: harmless for commands that never read
        # NODE_OPTIONS (gradlew, flutter's own launcher scripts, etc).
        node_opts_args = f"--max-old-space-size={NODE_HEAP_MB}"
        child_env["NODE_OPTIONS"] = " ".join(filter(None, [child_env.get("NODE_OPTIONS"), node_opts_args]))

        # Belt-and-suspenders against a build that "never completes": with no
        # stdin argument, asyncio inherits this *server's* stdin, which in a
        # container is typically closed/non-interactive but isn't guaranteed
        # to be. If any tool in the chain (npm, npx, a Capacitor/Gradle
        # prompt for an unexpected reason) ever tries to read a y/n
        # confirmation from stdin, an inherited-but-unresponsive stdin means
        # the child blocks forever waiting for input that will never arrive —
        # BUILD_TIMEOUT_MS's watchdog would still eventually kill it, but not
        # before wasting the full timeout window on every single such build.
        # Explicitly closing stdin makes any such prompt fail fast (EOF)
        # instead of hanging. CI=true / npm's non-interactive env vars are
        # the same idea one layer up: tell npm/npx/Capacitor's own CLIs not
        # to prompt at all.
        child_env["CI"] = "true"
        child_env["npm_config_yes"] = "true"
        child_env["NPM_CONFIG_FUND"] = "false"
        child_env["NPM_CONFIG_AUDIT"] = "false"

        try:
            process = await asyncio.create_subprocess_exec(
                command,
                *args,
                cwd=str(cwd or job.project_dir),
                env=child_env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,  # own process group, so a timeout kill can take any forked subprocesses with it
            )
        except OSError as exc:
            raise RuntimeError(f"Failed to start {command}: {exc}") from exc

        self.current_process = process
        lines_captured = 0
        last_activity_at = time.monotonic()

        # A command can go quiet for a long time without actually being
        # stuck — the clearest example is the Gradle wrapper downloading
        # its distribution zip: it prints one "Downloading ..." line, then
        # redraws a progress percentage using bare '\r' with no trailing
        # '\n', which our line-based capture below can't see at all until
        # either a real newline shows up or the stream hits EOF. Without
        # this, that silence is indistinguishable in the job log from an
        # actual hang. This doesn't (and can't, without reading raw
        # unbuffered bytes) reflect true download progress — it's a
        # liveness signal, not a progress bar — but "we're still here" is
        # exactly the missing piece of information for a job stuck as
        # "Downloading ..." with no output for minutes.
        HEARTBEAT_INTERVAL_S = 20

        async def pipe_lines(stream: asyncio.StreamReader | None) -> None:
            nonlocal lines_captured, last_activity_at
            if stream is None:
                return
            async for raw_line in stream:
                # A stream-level decode error is rare but should never take
                # down the whole process — one flaky build must not be able
                # to affect any other build sharing this container.
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
                if line.strip():
                    log(job, line)
                    lines_captured += 1
                last_activity_at = time.monotonic()

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL_S)
                if self.paused:
                    # Already logged once by pause() — no need to repeat
                    # "no new output" every 20s for a silence the user
                    # themselves asked for.
                    continue
                idle_s = time.monotonic() - last_activity_at
                if idle_s >= HEARTBEAT_INTERVAL_S:
                    log(
                        job,
                        f"(still running — no new output for {round(idle_s)}s; large downloads and "
                        "slow compiles can be silent for a while, this is not necessarily stuck)",
                    )

        heartbeat_task = asyncio.create_task(heartbeat())
        try:
            await asyncio.gather(pipe_lines(process.stdout), pipe_lines(process.stderr))
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task

        return_code = await process.wait()
        self.current_process = None

        if self.cancelled:
            raise BuildCancelled("Build stopped by user.")
        if self.timed_out:
            raise RuntimeError(f"Build timed out after {round(settings.BUILD_TIMEOUT_MS / 1000)}s.")
        if return_code != 0:
            # A failing command that produced literally no stdout/stderr is
            # itself a useful signal, not just a dead end — it almost always
            # means the process never got as far as doing real work (a
            # missing/corrupt executable, a bad shebang, a JVM classpath
            # entry pointing at a file that doesn't exist, etc.), rather
            # than a normal build-logic failure, which always logs
            # *something* on its way out. Surfacing that distinction here
            # means the job log always explains *why* it's uninformative
            # instead of just... being uninformative.
            normalized_code = _normalize_exit_code(return_code)
            if lines_captured == 0:
                log(
                    job,
                    f"(no output was produced by '{command}' before it exited with code {normalized_code} — "
                    "this usually points to a missing/corrupt executable or dependency, e.g. for a Gradle "
                    "wrapper, a missing gradle/wrapper/gradle-wrapper.jar, rather than a normal build error)",
                )
            exit_hint = _describe_exit_code(normalized_code)
            log(job, f"(exit code {normalized_code}: {exit_hint})")
            raise CommandFailed(
                f"{command} {' '.join(args)} exited with code {normalized_code} ({exit_hint}).",
                exit_code=normalized_code,
            )

    def run_gradle(self, gradlew_path: Path, android_dir: Path) -> Awaitable[None]:
        """Runs the project's own Gradle wrapper with flags that speed up a
        container-local build without changing what gets built:
          --no-daemon    required for the timeout-kill logic above to be
                         able to reap every JVM process Gradle forks.
          --build-cache  reuses task outputs across jobs instead of
                         recompiling unchanged ones every time; redirected
                         to a shared dir via --init-script (see
                         shared-build-cache-init.gradle).
        Deliberately NOT adding --parallel: MAX_CONCURRENT_BUILDS is
        already sized against this container's total RAM assuming each
        build is single-threaded on the Gradle side.
        """
        # Defense in depth alongside validate.py's own wrapper check: catch
        # a missing gradle-wrapper.jar/.properties here too, right before
        # the command that would otherwise fail on it with little to no
        # output (see the lines_captured==0 diagnostic in run()) — a
        # one-line error here beats reverse-engineering a near-silent
        # Gradle crash.
        wrapper_dir = gradlew_path.parent / "gradle" / "wrapper"
        missing = [
            name
            for name in ("gradle-wrapper.jar", "gradle-wrapper.properties")
            if not (wrapper_dir / name).exists()
        ]
        if missing:
            raise RuntimeError(
                f"Cannot run the Gradle wrapper — missing {', '.join(missing)} in "
                f"{wrapper_dir}. The project's Gradle wrapper is incomplete."
            )
        gradlew_path.chmod(0o755)
        return self.run(
            str(gradlew_path),
            [
                "assembleDebug",
                "--no-daemon",
                "--build-cache",
                "--init-script",
                str(SHARED_BUILD_CACHE_INIT_SCRIPT),
                f"-Dorg.gradle.jvmargs=-Xmx{GRADLE_HEAP_MB}m -Djava.net.preferIPv4Stack=true",
            ],
            cwd=android_dir,
        )


async def _run_build(job: Job) -> None:
    ctx = _BuildContext(job)
    _contexts[job.id] = ctx
    ctx.start_watchdog()

    try:
        set_status(job, "building")
        set_step(job, "Preparing build environment", 5)

        if job.project_type == "native-android":
            await _run_native_android_build(job, ctx)
        elif job.project_type == "flutter":
            await _run_flutter_build(job, ctx)
        else:
            await _run_capacitor_build(job, ctx)

        set_step(job, "Build complete", 100)
        log(job, "Build succeeded.")
        set_status(job, "success")
    except BuildCancelled as exc:
        log(job, f"Build stopped: {exc}")
        set_status(job, "stopped", str(exc))
    except CommandFailed as exc:
        log(job, f"ERROR: {exc}")
        set_status(job, "failed", str(exc), exit_code=exc.exit_code)
    except Exception as exc:  # noqa: BLE001 — a build failure must never crash the server
        log(job, f"ERROR: {exc}")
        set_status(job, "failed", str(exc))
    finally:
        ctx.cancel_watchdog()
        _contexts.pop(job.id, None)


async def _run_capacitor_build(job: Job, ctx: _BuildContext) -> None:
    """Path A: a web project (React/Vite/etc.), wrapped into an Android
    shell via Capacitor."""
    project_dir = job.project_dir
    android_dir = project_dir / "android"

    has_lockfile = (project_dir / "package-lock.json").exists()

    # Dependency cache: skip `npm ci`/`install` entirely when a previous
    # build already resolved this exact lockfile — see dep_cache.py.
    dep_hash = dep_cache.fingerprint(project_dir)
    cache_hit = dep_cache.restore(dep_hash, project_dir) if dep_hash else False

    if cache_hit:
        set_step(job, "Installing dependencies", 15, cacheHit=True)
        log(
            job,
            "Dependency cache hit — reusing a previously installed node_modules for this exact "
            "lockfile, skipping npm install.",
        )
        notice(
            job,
            level="info",
            title="Dependency cache hit",
            message="This project's package-lock.json matches a previous build, so npm install was skipped entirely.",
        )
    else:
        set_step(job, "Installing dependencies", 10, cacheHit=False)
        if dep_hash:
            log(job, "No matching dependency cache found — installing fresh (this will be cached for future builds with the same lockfile).")
        # --include=dev is explicit and outranks any NODE_ENV, .npmrc
        # "production=true"/"omit=dev", or NPM_CONFIG_* env var that might
        # otherwise cause devDependencies (the project's own build tool) to
        # be skipped.
        await ctx.run(
            "npm",
            [*(["ci"] if has_lockfile else ["install"]), "--include=dev", "--prefer-offline", "--no-audit", "--no-fund"],
        )
        if dep_hash:
            saved = dep_cache.save(dep_hash, project_dir)
            if saved:
                log(job, "Cached this dependency tree for future builds with the same lockfile.")

    set_step(job, "Building web assets", 30)
    await ctx.run("npm", ["run", "build"])

    web_dir = _detect_web_dir(project_dir)
    if not web_dir:
        raise RuntimeError("Couldn't find a web build output folder (looked for dist/, build/, www/, out/).")
    log(job, f"Detected web build output at {web_dir}/.")

    set_step(job, "Setting up Android project (Capacitor)", 45)
    await ctx.run(
        "npm",
        [
            "install", "--no-save", "--prefer-offline", "--no-audit", "--no-fund",
            f"@capacitor/core@{CAPACITOR_MAJOR}",
            f"@capacitor/cli@{CAPACITOR_MAJOR}",
            f"@capacitor/android@{CAPACITOR_MAJOR}",
        ],
    )

    has_existing_config = (project_dir / "capacitor.config.json").exists() or (project_dir / "capacitor.config.ts").exists()

    if has_existing_config:
        # `cap init` either refuses to run or overwrites an existing
        # config — neither is what we want here. A project that already
        # ships its own capacitor.config is telling us its actual
        # appId/appName/webDir; trust that instead of layering our own
        # defaults on top of it.
        log(job, "Found an existing capacitor.config — using it as-is instead of running cap init.")
        notice(
            job,
            level="info",
            title="Using existing Capacitor config",
            message="This project already had a capacitor.config file, so it was used as-is instead of generating a new one.",
        )
    else:
        await ctx.run("npx", ["cap", "init", APP_NAME, APP_ID, f"--web-dir={web_dir}"])

    await ctx.run("npx", ["cap", "add", "android"])
    await ctx.run("npx", ["cap", "copy", "android"])

    _patch_manifest_permissions(job, android_dir / "app" / "src" / "main" / "AndroidManifest.xml")

    set_step(job, "Compiling APK with Gradle", 65)
    await ctx.run_gradle(android_dir / "gradlew", android_dir)

    set_step(job, "Finalizing APK", 95)
    apk_source_path = android_dir / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
    if not apk_source_path.exists():
        raise RuntimeError("Gradle reported success but no APK was found at the expected output path.")

    _finalize_apk(job, apk_source_path)


async def _run_native_android_build(job: Job, ctx: _BuildContext) -> None:
    """Path B: a native Android project written in Kotlin and/or Java — its
    own Gradle project, built directly with no web/Capacitor step at all.
    The uploader's code is otherwise untouched: the only thing this build
    ever writes is permissions the uploader explicitly requested.
    """
    project_dir = job.project_dir
    gradlew_path = project_dir / "gradlew"
    if not gradlew_path.exists():
        raise RuntimeError("No gradlew found at the project root — a native Android project must include its Gradle wrapper.")

    log(job, "Native Kotlin/Java Android project detected — building directly with its own Gradle wrapper.")
    set_step(job, "Preparing native Android project", 20)

    # A module's manifest can live at any <module>/src/main/AndroidManifest.xml
    # (usually just app/, but multi-module projects are common) — search
    # for all of them rather than assuming the module is named "app".
    manifests = _find_files_recursive(project_dir, lambda name: name == "AndroidManifest.xml", _SOURCE_SEARCH_SKIP_DIRS)
    for manifest_path in manifests:
        _patch_manifest_permissions(job, manifest_path)

    set_step(job, "Compiling APK with Gradle", 50)
    await ctx.run_gradle(gradlew_path, project_dir)

    set_step(job, "Finalizing APK", 95)
    apk_debug_marker = f"{os.sep}outputs{os.sep}apk{os.sep}debug{os.sep}"
    apks = [
        p
        for p in _find_files_recursive(project_dir, lambda name: name.endswith(".apk"), _OUTPUT_SEARCH_SKIP_DIRS)
        if apk_debug_marker in str(p)
    ]

    if not apks:
        raise RuntimeError("Gradle reported success but no debug APK was found under any module's build/outputs/apk/debug/.")
    # Multiple modules could each produce a debug APK (e.g. an app module
    # plus a separate wear/instant module) — take the largest as the most
    # likely "main" app APK rather than guessing by name.
    apks.sort(key=lambda p: p.stat().st_size, reverse=True)

    _finalize_apk(job, apks[0])


def _flutter_org(app_id: str) -> str:
    """Derives a reverse-domain '--org' for `flutter create` from APP_ID
    (e.g. "com.builder.app" -> "com.builder") — only used as a fallback
    when an uploaded Flutter project didn't ship its own android/ folder,
    so the org just needs to be a valid reverse-domain string, not an
    exact match for anything.
    """
    parts = app_id.split(".")
    if len(parts) >= 2:
        return ".".join(parts[:-1])
    return "com.builder"


async def _run_flutter_build(job: Job, ctx: _BuildContext) -> None:
    """Path C: a Flutter (Dart) project. Unlike native-android, we never
    invoke gradlew directly — `flutter build apk` drives its own embedded
    android/ Gradle project internally (and shares this container's real
    Android SDK/JDK exactly as the other two paths do, since it's still
    Gradle underneath). The uploader's code is otherwise untouched: the
    only things this build ever writes are permissions the uploader
    explicitly requested, and — only if the upload didn't already include
    one — a generated android/ platform folder.
    """
    project_dir = job.project_dir
    android_dir = project_dir / "android"
    gradlew_path = android_dir / "gradlew"
    gradle_wrapper_jar = android_dir / "gradle" / "wrapper" / "gradle-wrapper.jar"

    log(job, "Flutter (Dart) project detected — building with the Flutter CLI.")
    set_step(job, "Fetching Flutter/Dart dependencies", 20)
    await ctx.run("flutter", ["pub", "get"])

    # An android/ folder existing is NOT the same as it being buildable.
    # `flutter create`'s own default .gitignore template excludes gradlew,
    # gradlew.bat, and gradle-wrapper.jar from version control — so any
    # Flutter project exported from a normal git repo (the overwhelmingly
    # common case for an upload) ships an android/ folder with everything
    # EXCEPT a working Gradle wrapper. Checking only `android_dir.exists()`
    # treats that as "already generated" and skips straight to
    # `flutter build apk`, which then fails deep inside Flutter's own
    # embedded Gradle invocation — almost always surfacing as a bare
    # non-zero exit code with little explanation, since the underlying
    # "Could not find or load main class ... GradleWrapperMain" happens a
    # layer below what this process's own logging can see.
    #
    # `flutter create --platforms=android .` against a directory that
    # already has a pubspec.yaml only ADDS files that don't already exist —
    # it never overwrites pubspec.yaml, lib/, or any android/ file already
    # present (that's what makes it safe to run unconditionally below, and
    # what's meant by "the missing platform folder" in the original
    # comment here). That same behavior makes it equally safe, and
    # necessary, to re-run when android/ exists but its wrapper doesn't:
    # it will fill in exactly the missing gradlew/gradle-wrapper.jar files
    # without touching anything else in an already-present android/.
    needs_regen = not android_dir.exists() or not gradlew_path.exists() or not gradle_wrapper_jar.exists()
    if needs_regen:
        if android_dir.exists():
            log(
                job,
                "android/ folder is missing its Gradle wrapper (gradlew / gradle-wrapper.jar) — "
                "this is expected for projects exported from git, since Flutter's default "
                ".gitignore excludes them. Regenerating the missing files before building.",
            )
        else:
            log(job, "No android/ folder in this project — generating one before building.")
        await ctx.run("flutter", ["create", "--platforms=android", f"--org={_flutter_org(APP_ID)}", "."])
        if not android_dir.exists() or not gradlew_path.exists() or not gradle_wrapper_jar.exists():
            raise RuntimeError(
                "flutter create ran but no working android/ Gradle wrapper (gradlew + "
                "gradle-wrapper.jar) was produced."
            )

    set_step(job, "Preparing Android manifest", 35)
    # Same reasoning as the native-android path above: search for every
    # AndroidManifest.xml under android/ rather than assuming one exact
    # path, since `flutter create` and hand-edited projects don't always
    # agree on the module layout.
    manifests = _find_files_recursive(android_dir, lambda name: name == "AndroidManifest.xml", _SOURCE_SEARCH_SKIP_DIRS)
    for manifest_path in manifests:
        _patch_manifest_permissions(job, manifest_path)

    set_step(job, "Compiling APK with Flutter", 55)
    # --debug (the default, see config.py's FLUTTER_BUILD_MODE) produces an
    # unsigned, installable-as-is APK with no signing config required —
    # the same trade-off the other two project types make. `flutter build
    # apk` handles the embedded Gradle invocation itself; it isn't run
    # through ctx.run_gradle() since there's no single gradlew path to
    # hand it (flutter build apk internally locates android/gradlew).
    await ctx.run("flutter", ["build", "apk", f"--{FLUTTER_BUILD_MODE}"])

    set_step(job, "Finalizing APK", 95)
    # Flutter's own build output lives under the *project* root's build/,
    # not under android/ — unlike the other two paths, whose Gradle output
    # is nested under android/app/build/.
    outputs_dir = project_dir / "build" / "app" / "outputs" / "flutter-apk"
    apk_source_path = outputs_dir / f"app-{FLUTTER_BUILD_MODE}.apk"
    if not apk_source_path.exists():
        # Fall back to a search, same pattern as the native-android path,
        # in case a Flutter version ever renames its default output file.
        found = [
            p
            for p in _find_files_recursive(project_dir, lambda name: name.endswith(".apk"), _OUTPUT_SEARCH_SKIP_DIRS)
            if "flutter-apk" in str(p)
        ]
        if found:
            found.sort(key=lambda p: p.stat().st_size, reverse=True)
            apk_source_path = found[0]
    if not apk_source_path.exists():
        raise RuntimeError(
            "Flutter reported success but no APK was found under build/app/outputs/flutter-apk/."
        )

    _finalize_apk(job, apk_source_path)


def _finalize_apk(job: Job, apk_source_path: Path) -> None:
    job.output_dir.mkdir(parents=True, exist_ok=True)
    final_apk_path = job.output_dir / "app.apk"
    shutil.copyfile(apk_source_path, final_apk_path)
    job.apk_path = final_apk_path
