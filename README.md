# apk-builder (Python / FastAPI port)

This is a full conversion of the original Express/Node backend to Python 3.12 +
FastAPI. It is **API-compatible** with the existing React dashboard in `web/`
— same routes, same JSON field names, same SSE event names — so the frontend
runs unmodified against this server.

## Layout

```
app/
  config.py         Settings (env-var driven), same defaults as the original
  job_store.py       In-memory job registry + async pub/sub (EventEmitter -> asyncio.Queue)
  validate.py         Zip safety checks, extraction, project-type detection
  permissions.py      Android permission whitelist/sanitizer
  dep_cache.py        Content-addressed node_modules hardlink cache
  build_runner.py      Build queue, memory admission control, subprocess build pipeline
  db.py                SQLite setup (schema, indexes, WAL) for visitor/country analytics
  visitors.py           Unique-visitor + reached-country tracking (IP-deduplicated)
  routes.py           API endpoints
  main.py             FastAPI app assembly, CORS, static hosting, error handling
  shared-build-cache-init.gradle   (unchanged Gradle init script)
web/                  Unmodified React dashboard
requirements.txt
Dockerfile
```

## Design notes / where this differs from a literal transliteration

- **Concurrency model**: Node's single-threaded event loop + `EventEmitter`
  maps directly onto Python's `asyncio` event loop + a small per-job
  `asyncio.Queue` fan-out (`job_store.EventBus`). No threads, no extra
  process — same single-process model as the original, so the existing
  `MAX_CONCURRENT_BUILDS` / memory-admission reasoning still applies as-is.
- **Subprocesses**: `asyncio.create_subprocess_exec(..., start_new_session=True)`
  replaces `child_process.spawn(..., { detached: true })`. Both put the child
  in its own process group so a build timeout can `killpg()` (Python) /
  `process.kill(-pid)` (Node) the whole tree, including whatever JVM workers
  Gradle forked.
- **Zip handling**: stdlib `zipfile` replaces `adm-zip`; the same zip-slip /
  forbidden-top-level / allowlisted-extension checks are re-implemented and
  unit-verified (path traversal, `android/` collision, single-folder
  flattening).
- **Dependency cache**: `shutil.copytree(src, dest, copy_function=os.link)`
  replaces `cp -al`, with a plain recursive-copy fallback if hardlinking
  fails (e.g. cache and project on different filesystems) — same intent as
  the original's own fallback.
- **Memory admission control**: `psutil.virtual_memory()` replaces
  `os.freemem()/os.totalmem()` for portability.
- **Upload size limiting**: enforced twice, matching multer's behavior —
  an ASGI middleware short-circuits on `Content-Length` before multipart
  parsing starts, and the upload handler also counts bytes while streaming
  to disk (so a request lying about `Content-Length` still gets capped).
- **Error shape**: all error responses are normalized to `{"error": "..."}`
  via FastAPI exception handlers, matching what `web/src/api.js` expects.
- **Visitor/country analytics**: `app/db.py` keeps a small SQLite database
  (`VISITOR_DB_PATH`, WAL mode) of one row per unique visitor IP (stored as
  a truncated SHA-256 hash, never the raw address), with a `CHECK`
  constraint on `country_code` and indexes on `last_seen`/`country_code` so
  the totals shown in the UI are indexed `COUNT`/`COUNT(DISTINCT)` queries
  rather than a full scan. Country is resolved via `GEOIP_LOOKUP_URL` once
  per new IP and cached in the row forever after. If a pre-database
  `visitors.json` (the old flat-file store) is found at startup, its rows
  are imported into the database once and the file renamed to
  `visitors.json.migrated`.

## Running locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Requires `node`, `npm`, `npx`, and (for native-Android uploads) a JDK +
Android SDK on `PATH` — exactly like the original, since builds still shell
out to those tools directly.

## Running via Docker

```bash
docker build -t apk-builder .
docker run -p 8000:8000 apk-builder
```

Same one-image-does-everything approach as the original: the `Dockerfile`
now installs a Python virtualenv for the FastAPI server *alongside* the
unchanged Node/JDK/Android-SDK toolchain the build subprocesses need.

## Environment variables

Identical names/defaults to the original — see `app/config.py`. `PORT`
now defaults to `8000` (uvicorn convention) instead of `3000`.

A few variables have no equivalent in the original Node app, since they
back features added on top of it: `VISITOR_DB_PATH`, `VISITOR_STORE_PATH`
(legacy migration source only), `GEOIP_LOOKUP_URL`, `GEOIP_TIMEOUT_S` — see
app/db.py and app/visitors.py.

Also new: `AI_API_KEY` (or `ANTHROPIC_API_KEY`) enables the optional
AI-assist panel that appears when a build fails (see app/ai_assist.py).
Leave it unset and the panel still appears but answers with a plain
"not configured" message instead of calling out to the AI provider —
nothing else about the app changes either way. `AI_MODEL`, `AI_API_URL`,
and `AI_TIMEOUT_S` override the provider/model/timeout if needed.
