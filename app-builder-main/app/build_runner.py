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
from .job_store import Job, log, notice, set_queue_position, set_status, set_step

SHARED_BUILD_CACHE_INIT_SCRIPT = Path(__file__).with_name("shared-build-cache-init.gradle")

APP_ID = os.environ.get("APP_ID", settings.APP_ID)
APP_NAME = os.environ.get("APP_NAME", settings.APP_NAME)
CAPACITOR_MAJOR = os.environ.get("CAPACITOR_MAJOR", settings.CAPACITOR_MAJOR)

# Created once at import time, shared by every job for the life of this
# process — see config.py for why these live outside JOB_ROOT.
settings.NPM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
settings.GRADLE_RO_DEP_CACHE.mkdir(parents=True, exist_ok=True)
settings.GRADLE_SHARED_BUILD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
settings.GRADLE_DIST_CACHE_DIR.mkdir(parents=True, exist_ok=True)
# Gradle's shared read-only dependency cache refuses to activate unless this
# exact subdirectory already exists — otherwise every build logs "Read-only
# cache is configured but the directory layout isn't expected" and silently
# falls back to a normal (unshared) cache. Pre-creating it once here is
# enough; Gradle populates its contents itself on first use.
(settings.GRADLE_RO_DEP_CACHE / "modules-2").mkdir(parents=True, exist_ok=True)

# Per-build Gradle JVM heap cap, sized against this container's *actual*
# total RAM rather than a fixed guess — see config.py's MIN_FREE_MEMORY_MB
# note. Reserve headroom for the server itself and the OS (RESERVED_MB),
# split the rest evenly across the concurrency budget, and clamp to a sane
# range.
_RESERVED_MB = 512
_MIN_BUILD_HEAP_MB = 768
_MAX_BUILD_HEAP_MB = 2048
_TOTAL_MB = psutil.virtual_memory().total / 1024 / 1024
GRADLE_HEAP_MB = max(
    _MIN_BUILD_HEAP_MB,
    min(_MAX_BUILD_HEAP_MB, int((_TOTAL_MB - _RESERVED_MB) / max(settings.MAX_CONCURRENT_BUILDS, 1))),
)

_queue: list[Job] = []
_running = 0
_memory_recheck_scheduled = False

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

    async def _timeout_watchdog(self) -> None:
        await asyncio.sleep(settings.BUILD_TIMEOUT_MS / 1000)
        self.timed_out = True
        if self.current_process is not None:
            # Kill the whole process group, not just the immediate child —
            # Gradle forks its own JVM worker processes even with
            # --no-daemon; killing only the wrapper script would leave
            # those orphaned instead of terminated.
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(os.getpgid(self.current_process.pid), signal.SIGKILL)

    def start_watchdog(self) -> None:
        self.timeout_task = asyncio.create_task(self._timeout_watchdog())

    def cancel_watchdog(self) -> None:
        if self.timeout_task is not None:
            self.timeout_task.cancel()

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
        gradle_jvm_args = f"-Xmx{GRADLE_HEAP_MB}m -Djava.net.preferIPv4Stack=true"
        child_env["GRADLE_OPTS"] = " ".join(filter(None, [child_env.get("GRADLE_OPTS"), gradle_jvm_args]))
        child_env.pop("JAVA_TOOL_OPTIONS", None)

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
            if lines_captured == 0:
                log(
                    job,
                    f"(no output was produced by '{command}' before it exited with code {return_code} — "
                    "this usually points to a missing/corrupt executable or dependency, e.g. for a Gradle "
                    "wrapper, a missing gradle/wrapper/gradle-wrapper.jar, rather than a normal build error)",
                )
            raise RuntimeError(f"{command} {' '.join(args)} exited with code {return_code}.")

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
    ctx.start_watchdog()

    try:
        set_status(job, "building")
        set_step(job, "Preparing build environment", 5)

        if job.project_type == "native-android":
            await _run_native_android_build(job, ctx)
        else:
            await _run_capacitor_build(job, ctx)

        set_step(job, "Build complete", 100)
        log(job, "Build succeeded.")
        set_status(job, "success")
    except Exception as exc:  # noqa: BLE001 — a build failure must never crash the server
        log(job, f"ERROR: {exc}")
        set_status(job, "failed", str(exc))
    finally:
        ctx.cancel_watchdog()


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


def _finalize_apk(job: Job, apk_source_path: Path) -> None:
    job.output_dir.mkdir(parents=True, exist_ok=True)
    final_apk_path = job.output_dir / "app.apk"
    shutil.copyfile(apk_source_path, final_apk_path)
    job.apk_path = final_apk_path
