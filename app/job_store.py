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
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import settings

settings.JOB_ROOT.mkdir(parents=True, exist_ok=True)


@dataclass
class Job:
    id: str
    filename: str
    dir: Path
    project_dir: Path
    output_dir: Path
    status: str = "queued"  # queued -> validating -> building -> success | failed
    queue_position: int | None = None
    logs: list[str] = field(default_factory=list)
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
    # ('capacitor-web', 'native-android', or 'flutter'); None until then.
    project_type: str | None = None


class EventBus:
    """Per-job fan-out of ``(event, payload)`` tuples to any number of
    concurrent SSE subscribers (multiple browser tabs watching the same
    job, a reconnect, etc)."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[asyncio.Queue]] = {}

    def subscribe(self, job_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
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
            queue.put_nowait((event, payload))

    def clear(self, job_id: str) -> None:
        self._subscribers.pop(job_id, None)


jobs: dict[str, Job] = {}
bus = EventBus()


def create_job(filename: str | None, permissions: list[str]) -> Job:
    job_id = str(uuid.uuid4())
    job_dir = settings.JOB_ROOT / job_id
    job = Job(
        id=job_id,
        filename=filename or "project.zip",
        dir=job_dir,
        project_dir=job_dir / "project",
        output_dir=job_dir / "output",
        permissions=list(permissions) if permissions else [],
    )
    jobs[job_id] = job
    return job


def log(job: Job, line: str) -> None:
    entry = f"[{_iso_now()}] {line}"
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


def set_status(job: Job, status: str, error: str | None = None) -> None:
    job.status = status
    if error:
        job.error = error
    bus.publish(job.id, "status", {"status": status, "error": job.error})
    if status in ("success", "failed"):
        bus.publish(job.id, "done", {"status": status, "error": job.error})


def purge_job(job: Job) -> None:
    import shutil

    shutil.rmtree(job.dir, ignore_errors=True)
    job.logs = []
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
