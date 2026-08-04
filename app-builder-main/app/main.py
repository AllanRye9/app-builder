"""FastAPI application entrypoint — equivalent to ``src/index.js``.

Run with:

    uvicorn app.main:app --host 0.0.0.0 --port 8000

(or just ``python -m app.main`` for local/dev use).
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware

from .config import settings
from .job_store import ttl_sweep_loop
from .routes import rate_limit_sweep_loop, router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("apk-builder")

# The React app is built to web/dist (see web/package.json + the
# Dockerfile) and served as static assets alongside the API from this same
# process.
_WEB_DIST_DIR = Path(__file__).resolve().parent.parent / "web" / "dist"

_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _background_tasks.append(asyncio.create_task(ttl_sweep_loop()))
    _background_tasks.append(asyncio.create_task(rate_limit_sweep_loop()))
    logger.info("APK builder listening on http://0.0.0.0:%d", settings.PORT)
    logger.info("Max concurrent builds: %d", settings.MAX_CONCURRENT_BUILDS)
    try:
        yield
    finally:
        for task in _background_tasks:
            task.cancel()
        for task in _background_tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass


app = FastAPI(title="apk-builder", lifespan=lifespan)


class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    """Defense-in-depth companion to the streaming size check in
    ``routes.upload``: rejects oversized uploads as early as the
    Content-Length header, before any multipart parsing work happens —
    equivalent to multer's ``limits.fileSize`` short-circuit.
    """

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > settings.MAX_UPLOAD_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={"error": f"Archive exceeds {settings.MAX_UPLOAD_BYTES // 1024 // 1024}MB limit."},
                    )
            except ValueError:
                pass
        return await call_next(request)


app.add_middleware(MaxBodySizeMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail}, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": "Invalid request.", "details": exc.errors()})


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error while processing request: %s", exc)
    return JSONResponse(status_code=500, content={"error": "Internal server error."})


app.include_router(router, prefix="/api")

# Mounted last so it doesn't shadow /api/* — serves the built React
# dashboard if present (it's fine for this to be absent in a dev
# environment where only the API is running).
if _WEB_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_WEB_DIST_DIR), html=True), name="web")
else:
    logger.warning("web/dist not found at %s — API-only mode (no dashboard served).", _WEB_DIST_DIR)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.PORT)
