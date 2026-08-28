"""In-memory job registry + a tiny async pub/sub bus.

Equivalent to ``src/jobStore.js``. Node's ``EventEmitter`` is replaced with
a small asyncio-native fan-out bus: each subscriber (an open SSE stream) gets
its own unbounded ``asyncio.Queue``; publishing an event pushes a copy onto
every subscriber currently attached to that job. Everything here runs on a
single event loop (the same threading model the original single-process
Express server used), so no additional locking is needed.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psutil

from .config import settings

settings.JOB_ROOT.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("apk-builder")


@dataclass
class Job:
    id: str
    filename: str
    dir: Path
    project_dir: Path
    output_dir: Path
    status: str = "queued"  # queued -> validating -> building -> success | failed
    queue_position: int | None = None
    # Bounded ring buffer (see config.JOB_LOG_BUFFER_LINES) — only the most
    # recent lines are kept in memory. The complete, untruncated log is
    # always written to log_file on disk as it happens (see log() below),
    # so bounding this doesn't lose any data, it just stops a long chatty
    # build from holding thousands of lines in RAM for its whole TTL.
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=settings.JOB_LOG_BUFFER_LINES))
    # True once `logs` has actually evicted an older line — lets the API/
    # frontend tell "this is genuinely the whole log" apart from "this is
    # a truncated tail, see log_file for the rest".
    logs_truncated: bool = False
    # Total number of log() calls for this job, independent of how many
    # of those lines are still buffered in `logs`.
    log_line_count: int = 0
    # Path to the full on-disk log for this job (job.dir / "build.log"),
    # set by create_job(). Always the complete record, never truncated.
    log_file: Path | None = None
    notices: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    apk_path: Path | None = None
    # Fine-grained progress within the 'building' macro-status — see
    # set_step() below. Distinct from `status` (which the frontend's
    # Pipeline stepper uses for its 4 big stages): this drives the
    # in-progress detail line and percentage bar inside the 'Build' stage
    # itself, e.g. "Installing dependencies (cache hit)" at 20% vs
    # "Compiling APK with Gradle" at 70%.
    step: str | None = None
    step_progress: int = 0
    # Chosen by whoever uploaded the project — never invented by the build
    # itself. See app/permissions.py for the whitelist/sanitizer and
    # app/build_runner.py for where these actually get applied.
    permissions: list[str] = field(default_factory=list)
    # Set once validate.py has inspected the extracted project
    # ('capacitor-web', 'react-native', 'native-android', or 'flutter'); None until then.
    project_type: str | None = None
    # True while a running build's subprocess (and every process it forked,
    # via SIGSTOP on the whole process group) is genuinely suspended — see
    # build_runner._BuildContext.pause()/resume(). Distinct from `status`,
    # which stays 'building' the whole time a build is paused; this is the
    # sub-flag the UI's pause/resume control actually reflects.
    paused: bool = False
    # The exit code of the command that actually failed, when `status` is
    # 'failed' and the failure was a non-zero process exit (as opposed to a
    # timeout, an internal server error, etc.) — None otherwise. Powers the
    # exit-code-aware messaging in the error banner and the assistant panel.
    exit_code: int | None = None


class EventBus:
    """Per-job fan-out of ``(event, payload)`` tuples to any number of
    concurrent SSE subscribers (multiple browser tabs watching the same
    job, a reconnect, etc)."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue]] = {}

    def subscribe(self, job_id: str) -> asyncio.Queue:
        # Bounded — see config.SSE_QUEUE_MAXSIZE. A subscriber that isn't
        # draining its queue (backgrounded tab, a connection the server
        # hasn't noticed died yet) must not be able to grow this without
        # bound for the entire life of a chatty build.
        queue: asyncio.Queue = asyncio.Queue(maxsize=settings.SSE_QUEUE_MAXSIZE)
        self._subscribers.setdefault(job_id, []).append(queue)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue) -> None:
        subs = self._subscribers.get(job_id)
        if not subs:
            return
        try:
            subs.remove(queue)
        except ValueError:
            pass
        if not subs:
            self._subscribers.pop(job_id, None)

    def publish(self, job_id: str, event: str, payload: Any) -> None:
        for queue in self._subscribers.get(job_id, ()):
            try:
                queue.put_nowait((event, payload))
            except asyncio.QueueFull:
                # Slow/stalled subscriber: drop the oldest buffered event
                # to make room for the newest one instead of growing
                # without bound. Losing an event from the middle of a
                # backgrounded tab's backlog is fine — the tab will still
                # get status/done and can always refetch /api/status; an
                # ever-growing queue per idle tab is not fine.
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait((event, payload))

    def clear(self, job_id: str) -> None:
        self._subscribers.pop(job_id, None)


jobs: dict[str, Job] = {}
bus = EventBus()


def create_job(filename: str | None, permissions: list[str]) -> Job:
    job_id = str(uuid.uuid4())
    job_dir = settings.JOB_ROOT / job_id
    # Created up front (not left to validate_and_extract's later
    # dest_dir.mkdir) because log() below is called immediately after
    # create_job() — before extraction — and needs somewhere to write
    # log_file from the very first line.
    job_dir.mkdir(parents=True, exist_ok=True)
    job = Job(
        id=job_id,
        filename=filename or "project.zip",
        dir=job_dir,
        project_dir=job_dir / "project",
        output_dir=job_dir / "output",
        permissions=list(permissions) if permissions else [],
        log_file=job_dir / "build.log",
    )
    jobs[job_id] = job
    return job


def log(job: Job, line: str) -> None:
    entry = f"[{_iso_now()}] {line}"
    job.log_line_count += 1

    # The complete record always goes to disk first, regardless of what
    # happens to the in-memory ring buffer below — this is what makes
    # bounding `logs` safe rather than lossy.
    if job.log_file is not None:
        try:
            with open(job.log_file, "a", encoding="utf-8") as fh:
                fh.write(entry + "\n")
        except OSError:
            pass  # Best-effort — a full/unwritable disk shouldn't crash the build.

    if job.logs.maxlen is not None and len(job.logs) >= job.logs.maxlen:
        job.logs_truncated = True
    job.logs.append(entry)

    bus.publish(job.id, "log", entry)


def notice(job: Job, *, level: str = "info", title: str = "", message: str = "") -> None:
    """A structured, UI-visible event — distinct from a plain log line.
    Emitted when the build dynamically decided or fixed something (matched
    a package version, installed a missing dependency, patched a config) so
    the frontend can surface it as a pop-up instead of leaving it buried in
    logs.
    """
    entry = {"level": level, "title": title, "message": message, "at": _iso_now()}
    job.notices.append(entry)
    bus.publish(job.id, "notice", entry)


def set_queue_position(job: Job, position: int | None) -> None:
    """How many builds are ahead of this one. Recomputed for every waiting
    job each time the queue changes, so a job that's been waiting sees its
    position count down in real time instead of a static "queued" label.
    """
    job.queue_position = position
    bus.publish(job.id, "queue", {"position": position})


def set_step(job: Job, label: str, progress: int, **meta: Any) -> None:
    """label: short human-readable description of what's happening right
    now. progress: 0-100, monotonic within a single build's 'building'
    status. meta: optional extra flags for the UI, e.g. cache_hit=True so a
    dependency-cache hit can be badged distinctly from a normal install.
    """
    job.step = label
    job.step_progress = progress
    payload: dict[str, Any] = {"step": label, "progress": progress}
    if meta:
        payload.update(meta)
    bus.publish(job.id, "step", payload)


def set_status(job: Job, status: str, error: str | None = None, *, exit_code: int | None = None) -> None:
    job.status = status
    if error:
        job.error = error
    if exit_code is not None:
        job.exit_code = exit_code
    # A fresh 'queued'/'validating' transition (a first upload, or a
    # rebuild after edits) means whatever exit code a *previous* attempt
    # ended on no longer applies to this one.
    if status in ("queued", "validating"):
        job.exit_code = None
    if status != "building":
        job.paused = False
    payload: dict[str, Any] = {"status": status, "error": job.error}
    if job.exit_code is not None:
        payload["exitCode"] = job.exit_code
    bus.publish(job.id, "status", payload)
    if status in ("success", "failed", "stopped"):
        bus.publish(job.id, "done", payload)


def set_paused(job: Job, paused: bool) -> None:
    """Reflects _BuildContext.pause()/resume() (see build_runner.py) — a
    genuine SIGSTOP/SIGCONT of the running build's whole process group, not
    a kill-and-requeue. `status` deliberately stays 'building' throughout;
    this is the orthogonal flag the UI's pause/resume control watches.
    """
    job.paused = paused
    bus.publish(job.id, "paused", {"paused": paused})


def purge_job(job: Job) -> None:
    import shutil

    shutil.rmtree(job.dir, ignore_errors=True)
    job.logs.clear()
    job.logs_truncated = False
    job.notices = []
    job.apk_path = None
    bus.clear(job.id)
    jobs.pop(job.id, None)


def _iso_now() -> str:
    return (
        time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        + f".{int((time.time() % 1) * 1000):03d}Z"
    )


async def ttl_sweep_loop() -> None:
    """Fallback sweep for jobs nobody ever downloaded (browser closed,
    crash, etc). Mirrors the original's 5-minute interval."""
    interval_s = 5 * 60
    while True:
        await asyncio.sleep(interval_s)
        now = time.time()
        ttl_s = settings.JOB_TTL_MS / 1000
        for job in list(jobs.values()):
            if now - job.created_at > ttl_s:
                purge_job(job)


async def memory_pressure_sweep_loop() -> None:
    """Reclaims memory faster than ttl_sweep_loop() when this container is
    genuinely low on RAM, instead of only when the full JOB_TTL_MS (an
    hour, by default) has elapsed.

    The `jobs` registry — logs, notices, and each job's on-disk dir — is
    real, resident cost that otherwise sits untouched for up to an hour
    even while build_runner._pump() is refusing to start new builds
    because free memory is under MIN_FREE_MEMORY_MB. A burst of
    large/abandoned uploads can make that squeeze self-sustaining: the
    queue stays blocked on low memory, and the finished jobs that would
    free that memory aren't eligible for cleanup yet.

    This loop polls real free memory on the same MIN_FREE_MEMORY_MB
    threshold the build queue itself uses and, only while that threshold
    is actually being violated, purges the oldest *terminal* jobs
    (success/failed/stopped — never queued/validating/building) once
    they've had at least MEMORY_PRESSURE_JOB_TTL_MS to be downloaded/read,
    stopping as soon as memory recovers above the threshold.
    """
    interval_s = settings.MEMORY_PRESSURE_CHECK_INTERVAL_S
    grace_s = settings.MEMORY_PRESSURE_JOB_TTL_MS / 1000
    while True:
        await asyncio.sleep(interval_s)

        if psutil.virtual_memory().available / 1024 / 1024 >= settings.MIN_FREE_MEMORY_MB:
            continue

        now = time.time()
        candidates = sorted(
            (
                job
                for job in jobs.values()
                if job.status in ("success", "failed", "stopped") and now - job.created_at > grace_s
            ),
            key=lambda job: job.created_at,
        )
        for job in candidates:
            job_id = job.id
            purge_job(job)
            # Not logged via job_store.log() — the job (and its log_file)
            # no longer exists after purge_job(); this is server-side
            # observability only.
            logger.info("Purged job %s early to relieve low-memory pressure on this container.", job_id)
            if psutil.virtual_memory().available / 1024 / 1024 >= settings.MIN_FREE_MEMORY_MB:
                break
