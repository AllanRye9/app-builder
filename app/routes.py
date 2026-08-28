"""API routes — equivalent to ``src/routes.js``.

Endpoint shapes (paths, JSON field names, SSE event names) are kept
byte-for-byte compatible with the existing React dashboard in ``web/``, so
that frontend can be pointed at this server unmodified.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from pathlib import Path

import psutil
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import build_runner
from .config import settings
from .job_store import Job, bus, create_job, jobs, log, notice, purge_job, set_status
from .permissions import sanitize_permissions
from .validate import ValidationError, validate_and_extract
from . import visitors
from . import auth
from . import assist
from . import project_files

router = APIRouter()

_UPLOAD_DIR = settings.JOB_ROOT / "_uploads"
_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Minimal per-IP rate limiter for the upload endpoint
# ---------------------------------------------------------------------------
# Each build is real, sustained CPU/memory work sharing this one container's
# resources, so an open upload endpoint needs a basic abuse guard. This is a
# small, dependency-free sliding-window counter — enough for a single-
# instance worker. It is deliberately simple: swap for a real rate limiter
# (or push this to a reverse proxy) if this ever runs as multiple instances
# behind a load balancer, since this state is per-process.
_upload_hits: dict[str, list[float]] = {}


def _require_job(job_id: str) -> Job:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    return job


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _check_rate_limit(request: Request) -> None:
    ip = _client_ip(request)
    now = time.time()
    window_start = now - settings.RATE_LIMIT_WINDOW_MS / 1000

    hits = [t for t in _upload_hits.get(ip, []) if t > window_start]

    if len(hits) >= settings.RATE_LIMIT_MAX:
        retry_after_s = hits[0] + settings.RATE_LIMIT_WINDOW_MS / 1000 - now
        raise HTTPException(
            status_code=429,
            detail=f"Too many builds started from this connection. Try again in {int(retry_after_s / 60) + 1} min.",
            headers={"Retry-After": str(max(1, round(retry_after_s)))},
        )

    hits.append(now)
    _upload_hits[ip] = hits


async def rate_limit_sweep_loop() -> None:
    """Sweeps stale IP entries so this dict doesn't grow unbounded under
    sustained high-volume traffic."""
    interval_s = settings.RATE_LIMIT_WINDOW_MS / 1000
    while True:
        await asyncio.sleep(interval_s)
        window_start = time.time() - settings.RATE_LIMIT_WINDOW_MS / 1000
        for ip in list(_upload_hits.keys()):
            kept = [t for t in _upload_hits[ip] if t > window_start]
            if kept:
                _upload_hits[ip] = kept
            else:
                _upload_hits.pop(ip, None)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/health")
async def health() -> dict:
    """Most hosting platforms poll a path like this to decide if the
    instance is healthy enough to receive traffic — deliberately cheap, no
    disk/job-store access, so it stays fast even while builds are running.
    """
    return {"ok": True}


@router.get("/system")
async def system_status(user: auth.User = Depends(auth.require_auth)) -> dict:
    """Powers the dashboard's global status bar — a standardized,
    always-visible read on the container's real capacity, so "why is my
    build not starting yet" has a visible answer instead of a silent queue.
    """
    counts = build_runner.get_build_counts()
    vm = psutil.virtual_memory()
    total_mb = round(vm.total / 1024 / 1024)
    free_mb = round(vm.available / 1024 / 1024)
    return {
        "running": counts["running"],
        "queued": counts["queued"],
        "maxConcurrentBuilds": settings.MAX_CONCURRENT_BUILDS,
        "memory": {
            "totalMb": total_mb,
            "freeMb": free_mb,
            "usedMb": total_mb - free_mb,
            "minFreeMb": settings.MIN_FREE_MEMORY_MB,
            "lowMemory": free_mb < settings.MIN_FREE_MEMORY_MB,
        },
    }


async def _save_upload(file: UploadFile, dest_path: Path) -> int:
    """Streams the upload to disk in chunks, enforcing MAX_UPLOAD_BYTES as
    a hard cap regardless of what (if anything) the Content-Length header
    claimed — mirrors multer's ``limits.fileSize`` behavior.
    """
    size = 0
    chunk_size = 1024 * 1024
    try:
        with dest_path.open("wb") as out:
            while chunk := await file.read(chunk_size):
                size += len(chunk)
                if size > settings.MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Archive exceeds {settings.MAX_UPLOAD_BYTES // 1024 // 1024}MB limit.",
                    )
                out.write(chunk)
    finally:
        await file.close()
    return size


@router.post("/visitors/ping")
async def visitors_ping(request: Request, user: auth.User = Depends(auth.require_auth)) -> dict:
    """Called once per dashboard load (see web/src/api.js). Records this
    visitor if their IP hasn't been seen before (or refreshes their
    "last seen" date if it has) and returns the current totals in the
    same round trip.
    """
    return await visitors.record_visit(request)


@router.get("/visitors/stats")
async def visitors_stats(user: auth.User = Depends(auth.require_auth)) -> dict:
    """Read-only refresh for the standing counter in the UI — does not
    itself count as a visit.
    """
    return await visitors.get_stats()


class AssistRequest(BaseModel):
    question: str
    context: dict | None = None
    history: list[dict] | None = None


@router.post("/assist")
async def assist_endpoint(body: AssistRequest, user: auth.User = Depends(auth.require_auth)) -> dict:
    """Powers the error side panel (web/src/components/ErrorAssistant.jsx).
    Only ever reachable once signed in, same as everything else here —
    see assist.py for the AI/fallback split.
    """
    return await assist.answer(body.question, body.context or {}, body.history or [])



@router.post("/upload")
async def upload(
    request: Request,
    zip: UploadFile | None = None,
    permissions: str | None = Form(default=None),
    user: auth.User = Depends(auth.require_auth),
) -> JSONResponse:
    _check_rate_limit(request)

    if zip is None or not zip.filename:
        raise HTTPException(status_code=400, detail='No file uploaded. Field name must be "zip".')
    if not zip.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip archives are accepted.")

    upload_path = _UPLOAD_DIR / f"{time.time_ns()}-{zip.filename}"
    try:
        size = await _save_upload(zip, upload_path)
    except HTTPException:
        upload_path.unlink(missing_ok=True)
        raise

    # Permissions are the uploader's call, not something the build invents —
    # the raw form field is sanitized against a whitelist before it ever
    # reaches a job.
    sanitized_permissions = sanitize_permissions(permissions)

    job = create_job(zip.filename, sanitized_permissions)
    set_status(job, "validating")
    log(job, f"Received {zip.filename} ({size / 1024 / 1024:.1f} MB).")
    if sanitized_permissions:
        log(job, f"Requested permissions: {', '.join(sanitized_permissions)}")

    try:
        result = validate_and_extract(upload_path, job.project_dir)
        job.project_type = result.project_type
        if result.project_type == "native-android":
            validation_message = "Validation passed: native Kotlin/Java Android (Gradle) project detected."
        elif result.project_type == "flutter":
            validation_message = "Validation passed: Flutter (Dart) project detected."
        elif result.project_type == "react-native":
            validation_message = "Validation passed: React Native project detected (its own android/ Gradle project will be built directly)."
        else:
            validation_message = "Validation passed: plain React/Capacitor-ready project detected."
        log(job, validation_message)
        if result.skipped:
            log(job, f"Skipped {len(result.skipped)} file(s) not needed to build the app: {', '.join(result.skipped)}")
            skipped_list = result.skipped
            message = (
                f"Not needed to build the app, so left out: {', '.join(skipped_list)}."
                if len(skipped_list) <= 3
                else (
                    f"Not needed to build the app, so left out: {', '.join(skipped_list[:3])}, "
                    f"and {len(skipped_list) - 3} more. See the build log for the full list."
                )
            )
            notice(
                job,
                level="info",
                title=f"Skipped {len(skipped_list)} unused file{'' if len(skipped_list) == 1 else 's'}",
                message=message,
            )
        upload_path.unlink(missing_ok=True)
        build_runner.enqueue(job)
        return JSONResponse(status_code=202, content={"jobId": job.id})
    except ValidationError as exc:
        upload_path.unlink(missing_ok=True)
        set_status(job, "failed", str(exc))
        log(job, f"Validation failed: {exc}")
        notice(job, level="error", title="Archive rejected", message=str(exc))
        return JSONResponse(status_code=202, content={"jobId": job.id})  # still trackable via status endpoint
    except Exception as exc:
        upload_path.unlink(missing_ok=True)
        set_status(job, "failed", "Unexpected server error during validation.")
        log(job, f"ERROR: {exc}")
        raise HTTPException(status_code=500, detail="Unexpected server error.") from exc


@router.get("/status/{job_id}")
async def get_status(job_id: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    return {
        "id": job.id,
        "filename": job.filename,
        "status": job.status,
        "queuePosition": job.queue_position,
        "error": job.error,
        # job.logs is a bounded deque (see config.JOB_LOG_BUFFER_LINES) —
        # cast to a list for JSON serialization. logsTruncated/logLineCount
        # tell the frontend whether this is the whole log or a tail, and
        # /api/logs/{id}/full always has the complete on-disk record.
        "logs": list(job.logs),
        "logsTruncated": job.logs_truncated,
        "logLineCount": job.log_line_count,
        "notices": job.notices,
        "downloadReady": job.status == "success" and job.apk_path is not None,
        "projectType": job.project_type,
        "permissions": job.permissions,
        "step": job.step,
        "stepProgress": job.step_progress,
        "paused": job.paused,
        "exitCode": job.exit_code,
    }


# ---------------------------------------------------------------------------
# Build control: pause / resume / cancel / rebuild
# ---------------------------------------------------------------------------
# Pause/resume genuinely suspend and continue the running build's own
# subprocess (SIGSTOP/SIGCONT on its whole process group — see
# build_runner._BuildContext) rather than kill-and-restart. Cancel kills it
# outright (or dequeues it if it hadn't started yet). Rebuild re-runs a
# job's build from its current on-disk project files — the natural next
# step after cancelling to make an edit, or after a straight build failure.


@router.post("/jobs/{job_id}/pause")
async def pause_job(job_id: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    job = _require_job(job_id)
    ok, message = await build_runner.pause_job(job_id)
    return {"ok": ok, "message": message, "paused": job.paused}


@router.post("/jobs/{job_id}/resume")
async def resume_job(job_id: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    job = _require_job(job_id)
    ok, message = await build_runner.resume_job(job_id)
    return {"ok": ok, "message": message, "paused": job.paused}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    _require_job(job_id)
    ok, message = await build_runner.cancel_job(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail=message)
    return {"ok": True, "message": message}


@router.post("/jobs/{job_id}/rebuild")
async def rebuild_job(job_id: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    """Re-runs the build using whatever's currently on disk under
    job.project_dir — the same extracted project, plus any edits made via
    the file endpoints below. Existing dependency/Gradle caches are
    reused exactly as they would be for a brand new job with the same
    lockfile, so a rebuild after a small fix is typically much faster
    than the original build.
    """
    job = _require_job(job_id)
    if job.status in ("queued", "validating", "building"):
        raise HTTPException(status_code=409, detail="This build is already running.")
    if not job.project_dir.exists():
        raise HTTPException(status_code=409, detail="No project files remain for this job — please re-upload.")

    job.error = None
    job.exit_code = None
    job.step = None
    job.step_progress = 0
    job.apk_path = None
    job.logs.clear()
    job.logs_truncated = False
    job.log_line_count = 0
    # Start the on-disk log fresh too, rather than appending this rebuild
    # after a stale previous attempt's log — job.log_file's *path* doesn't
    # change, only its contents.
    if job.log_file is not None:
        with contextlib.suppress(OSError):
            job.log_file.unlink()
    job.notices = []
    set_status(job, "queued")
    log(job, "Rebuild requested — re-running the build with the current project files.")
    build_runner.enqueue(job)
    return {"ok": True, "jobId": job.id}


# ---------------------------------------------------------------------------
# Project file browser / quick-fix editor
# ---------------------------------------------------------------------------
# Operates directly on job.project_dir — the same extracted source the
# next build (or rebuild) will run against. Meant for small, targeted
# corrections (a typo in a Gradle file, a missing config value) prompted
# by a build failure, not a full development environment — see
# project_files.py for the size/type limits this enforces.


def _file_api_error(exc: project_files.FileApiError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("/jobs/{job_id}/files")
async def list_project_files(job_id: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    job = _require_job(job_id)
    return project_files.build_tree(job.project_dir)


@router.get("/jobs/{job_id}/files/content")
async def get_project_file(job_id: str, path: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    job = _require_job(job_id)
    try:
        return project_files.read_file(job.project_dir, path)
    except project_files.FileApiError as exc:
        raise _file_api_error(exc) from exc


class FileContentBody(BaseModel):
    path: str
    content: str


@router.put("/jobs/{job_id}/files/content")
async def save_project_file(
    job_id: str, body: FileContentBody, user: auth.User = Depends(auth.require_auth)
) -> dict:
    job = _require_job(job_id)
    try:
        result = project_files.write_file(job.project_dir, body.path, body.content, create=False)
    except project_files.FileApiError as exc:
        raise _file_api_error(exc) from exc
    log(job, f"Edited {body.path} via the in-browser editor.")
    return result


class CreateFileBody(BaseModel):
    path: str
    isDir: bool = False
    content: str = ""


@router.post("/jobs/{job_id}/files")
async def create_project_file(
    job_id: str, body: CreateFileBody, user: auth.User = Depends(auth.require_auth)
) -> dict:
    job = _require_job(job_id)
    try:
        if body.isDir:
            result = project_files.create_dir(job.project_dir, body.path)
        else:
            result = project_files.write_file(job.project_dir, body.path, body.content, create=True)
    except project_files.FileApiError as exc:
        raise _file_api_error(exc) from exc
    log(job, f"Added {'folder' if body.isDir else 'file'} {body.path} via the in-browser editor.")
    return result


@router.delete("/jobs/{job_id}/files")
async def delete_project_file(job_id: str, path: str, user: auth.User = Depends(auth.require_auth)) -> dict:
    job = _require_job(job_id)
    try:
        result = project_files.delete_path(job.project_dir, path)
    except project_files.FileApiError as exc:
        raise _file_api_error(exc) from exc
    log(job, f"Deleted {path} via the in-browser editor.")
    return result


class RenameFileBody(BaseModel):
    from_path: str = Field(alias="from")
    to: str

    class Config:
        populate_by_name = True


@router.patch("/jobs/{job_id}/files")
async def rename_project_file(
    job_id: str, body: RenameFileBody, user: auth.User = Depends(auth.require_auth)
) -> dict:
    job = _require_job(job_id)
    try:
        result = project_files.rename_path(job.project_dir, body.from_path, body.to)
    except project_files.FileApiError as exc:
        raise _file_api_error(exc) from exc
    log(job, f"Renamed {body.from_path} → {body.to} via the in-browser editor.")
    return result


def _sse(event: str | None, data: object) -> str:
    prefix = f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


@router.get("/logs/{job_id}/stream")
async def stream_logs(job_id: str, request: Request, user: auth.User = Depends(auth.require_auth)) -> StreamingResponse:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404)

    async def event_generator():
        # Replay what's already happened, then stream new lines. job.logs
        # is only the most recent JOB_LOG_BUFFER_LINES (see config.py) —
        # tell a freshly (re)connecting client up front if that's a
        # truncated tail rather than the whole build, so it knows
        # GET /api/logs/{id}/full exists for the complete record.
        if job.logs_truncated:
            yield _sse(
                "notice",
                {
                    "level": "info",
                    "title": "Log truncated",
                    "message": (
                        f"Showing the most recent {len(job.logs)} of {job.log_line_count} log lines. "
                        "Download the full log for the complete build output."
                    ),
                },
            )
        for line in job.logs:
            yield _sse(None, line)
        for entry in job.notices:
            yield _sse("notice", entry)
        yield _sse("status", {"status": job.status, "error": job.error, "exitCode": job.exit_code})
        if job.queue_position is not None:
            yield _sse("queue", {"position": job.queue_position})
        if job.step:
            yield _sse("step", {"step": job.step, "progress": job.step_progress})
        if job.paused:
            yield _sse("paused", {"paused": True})

        # A job can already be terminal by the time the client connects —
        # e.g. an archive that fails validation goes straight to 'failed'
        # synchronously, before the browser even opens this stream.
        # Without this, that client would never see a 'done' event and
        # would be stuck showing "queued" forever. Same fix also makes a
        # reconnect/second tab work correctly for any already-finished job.
        if job.status in ("success", "failed", "stopped"):
            yield _sse("done", {"status": job.status, "error": job.error, "exitCode": job.exit_code})
            return

        queue = bus.subscribe(job_id)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event, payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    # Periodic SSE comment as a keep-alive/ping so
                    # intermediary proxies don't time out an idle
                    # connection; also doubles as our disconnect-check tick.
                    yield ": ping\n\n"
                    continue
                yield _sse(event, payload)
                if event == "done":
                    break
        finally:
            bus.unsubscribe(job_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.get("/logs/{job_id}/full")
async def download_full_log(job_id: str, user: auth.User = Depends(auth.require_auth)):
    """Complement to the bounded in-memory `job.logs` (config.
    JOB_LOG_BUFFER_LINES): every line ever logged for this job is written
    to job.log_file on disk as it happens (see job_store.log()), so
    nothing is actually lost by bounding the in-memory copy — this just
    gives a way to retrieve the full record when it has been truncated in
    the live view or the status/SSE response.
    """
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    if job.log_file is None or not job.log_file.exists():
        raise HTTPException(status_code=404, detail="No log file available for this job.")
    return FileResponse(
        path=job.log_file,
        media_type="text/plain",
        filename=f"apkit-{job.id}.log",
    )


@router.get("/download/{job_id}")
async def download(job_id: str, background_tasks: BackgroundTasks, user: auth.User = Depends(auth.require_auth)):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    if job.status != "success" or not job.apk_path or not job.apk_path.exists():
        raise HTTPException(status_code=409, detail="APK not ready.")

    # Transfer finishes successfully -> wipe the project source, build
    # output, and logs for this job immediately rather than waiting for the
    # TTL sweep. A client that aborts mid-transfer simply never triggers
    # this background task, leaving the job intact so they can retry.
    background_tasks.add_task(purge_job, job)

    return FileResponse(
        path=job.apk_path,
        media_type="application/vnd.android.package-archive",
        filename="app.apk",
        background=background_tasks,
    )
