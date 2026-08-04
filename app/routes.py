"""API routes — equivalent to ``src/routes.js``.

Endpoint shapes (paths, JSON field names, SSE event names) are kept
byte-for-byte compatible with the existing React dashboard in ``web/``, so
that frontend can be pointed at this server unmodified.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import psutil
from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import auth
from . import build_runner
from . import visitors
from .config import settings
from .job_store import bus, create_job, jobs, log, notice, purge_job, set_status
from .permissions import sanitize_permissions
from .validate import ValidationError, validate_and_extract

router = APIRouter()


# ---------------------------------------------------------------------------
# Auth — required for the actual build service (upload/status/logs/download)
# below. EventSource (used by the log stream) can't set a custom header, so
# the token is accepted either as a Bearer header or a ?token= query param.
# ---------------------------------------------------------------------------


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return request.query_params.get("token")


async def require_user(request: Request) -> auth.User:
    user = auth.user_for_token(_bearer_token(request))
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required.")
    return user

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


@router.post("/auth/signup", status_code=201)
async def auth_signup(request: Request) -> dict:
    body = await request.json()
    try:
        user, token = auth.signup(str(body.get("email", "")), str(body.get("password", "")))
    except auth.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"token": token, "email": user.email}


@router.post("/auth/login")
async def auth_login(request: Request) -> dict:
    body = await request.json()
    try:
        user, token = auth.login(str(body.get("email", "")), str(body.get("password", "")))
    except auth.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return {"token": token, "email": user.email}


@router.post("/auth/logout")
async def auth_logout(request: Request, _user: auth.User = Depends(require_user)) -> dict:
    auth.logout(_bearer_token(request))
    return {"ok": True}


@router.get("/auth/me")
async def auth_me(user: auth.User = Depends(require_user)) -> dict:
    return {"email": user.email}


@router.post("/visitors/ping")
async def visitors_ping(request: Request) -> dict:
    """Called once per browser session (see web/src/lib/visitor.js) to
    record a visit and hand back the freshly-aggregated totals in the same
    round trip — the dashboard's animated counter needs both anyway, and
    this avoids a second request just to read what the first one wrote.
    """
    body = await request.json()
    visitor_id = str(body.get("visitorId") or "").strip()
    if not visitor_id or len(visitor_id) > 128:
        raise HTTPException(status_code=400, detail="Missing or invalid visitorId.")
    country = visitors.country_from_request(request)
    stats = visitors.record_visit(visitor_id, country)
    return {
        "total": stats.total,
        "today": stats.today,
        "countries": stats.countries,
    }


@router.get("/visitors")
async def visitors_stats() -> dict:
    stats = visitors.get_stats()
    return {
        "total": stats.total,
        "today": stats.today,
        "countries": stats.countries,
    }


@router.get("/system")
async def system_status() -> dict:
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


@router.post("/upload", status_code=202)
async def upload(
    request: Request,
    zip: UploadFile | None = None,
    permissions: str | None = Form(default=None),
    _user: auth.User = Depends(require_user),
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
        log(
            job,
            "Validation passed: native Kotlin/Java Android (Gradle) project detected."
            if result.project_type == "native-android"
            else "Validation passed: plain React/Capacitor-ready project detected.",
        )
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
async def get_status(job_id: str, _user: auth.User = Depends(require_user)) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id.")
    return {
        "id": job.id,
        "filename": job.filename,
        "status": job.status,
        "queuePosition": job.queue_position,
        "error": job.error,
        "logs": job.logs,
        "notices": job.notices,
        "downloadReady": job.status == "success" and job.apk_path is not None,
        "projectType": job.project_type,
        "permissions": job.permissions,
        "step": job.step,
        "stepProgress": job.step_progress,
    }


def _sse(event: str | None, data: object) -> str:
    prefix = f"event: {event}\n" if event else ""
    return f"{prefix}data: {json.dumps(data)}\n\n"


@router.get("/logs/{job_id}/stream")
async def stream_logs(job_id: str, request: Request, _user: auth.User = Depends(require_user)) -> StreamingResponse:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404)

    async def event_generator():
        # Replay what's already happened, then stream new lines.
        for line in job.logs:
            yield _sse(None, line)
        for entry in job.notices:
            yield _sse("notice", entry)
        yield _sse("status", {"status": job.status, "error": job.error})
        if job.queue_position is not None:
            yield _sse("queue", {"position": job.queue_position})
        if job.step:
            yield _sse("step", {"step": job.step, "progress": job.step_progress})

        # A job can already be terminal by the time the client connects —
        # e.g. an archive that fails validation goes straight to 'failed'
        # synchronously, before the browser even opens this stream.
        # Without this, that client would never see a 'done' event and
        # would be stuck showing "queued" forever. Same fix also makes a
        # reconnect/second tab work correctly for any already-finished job.
        if job.status in ("success", "failed"):
            yield _sse("done", {"status": job.status, "error": job.error})
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


@router.get("/download/{job_id}")
async def download(job_id: str, background_tasks: BackgroundTasks, _user: auth.User = Depends(require_user)):
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
