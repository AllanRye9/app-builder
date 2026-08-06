<div align="center">

# apkit

**Drop a project, get back an APK.**

Zip a web, native Android, or Flutter project and apkit turns it into an installable Android
package — no local Android Studio, no signing setup, no Gradle configuration.

[Features](#features) ·
[Quickstart](#quickstart) ·
[Project structure](#project-structure) ·
[API reference](#api-reference) ·
[Configuration](#configuration) ·
[Architecture](#architecture)

</div>

---

## Overview

apkit is a single self-contained service: a FastAPI backend that validates an uploaded `.zip`,
builds it into an APK using the real Android/Gradle/Flutter toolchain, and streams the build log
back live — paired with a React dashboard for uploading projects, watching builds, and downloading
the result.

Three project shapes are accepted, auto-detected from the archive's own contents:

| Project type | Detected by | Built with |
| --- | --- | --- |
| **Web / Capacitor** | `package.json` | `npm run build` → wrapped into an Android shell via [Capacitor](https://capacitorjs.com) |
| **Native Android** | `settings.gradle(.kts)` + root `build.gradle(.kts)` | The project's own Gradle wrapper, run directly |
| **Flutter** | `pubspec.yaml` | `flutter build apk` |

No flag to set, no dropdown to pick — the archive tells the server what it is. A project doesn't
even need to sit at the archive root: a wrapper folder, a workspace folder, or several nested
folders are auto-detected and promoted to the build root.

## Features

- **Three build paths, one upload flow** — web/Capacitor, native Android, and Flutter, unified
  behind the same validate → queue → build → download pipeline.
- **Live build logs** over Server-Sent Events, with heartbeat pings so a long silent stretch (a
  large Gradle distribution download, a slow compile) never looks like a hang.
- **Client-side archive preview** — the browser inspects the `.zip` locally (nothing uploaded yet)
  and shows the detected project type, flags anything that will be rejected, and lists which files
  will be skipped, before the person commits to an upload.
- **Shared, persistent build caches** — npm packages, Gradle dependencies/wrapper distributions/
  build cache, and Flutter's pub cache are all reused across jobs in the same container, so only
  the *first* build of a given dependency set pays the download cost.
- **Real memory-aware admission control** — builds queue based on this container's actual
  available RAM (`psutil`), not just a fixed concurrency count, so a burst of uploads degrades to
  "queued" instead of taking the whole service down.
- **Requested-permissions-only manifest patching** — Android permissions come from an explicit
  allowlist chosen at upload time and are the *only* thing ever written into the uploaded
  project's `AndroidManifest.xml`; nothing is invented on the app's behalf.
- **AI-assisted troubleshooting** on build failure, backed by the Anthropic API when configured,
  with a built-in rule-based fallback so the feature degrades gracefully rather than disappearing.
- **Accounts, sessions, and per-IP rate limiting** — the whole dashboard sits behind auth, tokens
  work across a primary/fallback API host, and the upload endpoint has its own abuse guard.
- **Lightweight visitor/country analytics**, IP-deduplicated and hashed rather than stored raw.

## Quickstart

### Prerequisites (local run)

Builds shell out to the real toolchains directly, so these need to be on `PATH`:

- Python 3.12+
- Node.js + npm/npx (web/Capacitor builds, and the dashboard's own build step)
- A JDK + the Android SDK (`ANDROID_SDK_ROOT`/`ANDROID_HOME`) — native Android and Flutter builds
- The Flutter SDK — Flutter builds only

The [`Dockerfile`](./Dockerfile) installs and pins all of the above; using it is the fastest way
to get a working environment without assembling the toolchain by hand.

### Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Build the dashboard once (served as static files by the same process):

```bash
cd web && npm install && npm run build
```

### Run with Docker

```bash
docker build -t apkit .
docker run -p 8000:8000 apkit
```

One image, one process: the FastAPI server and the full web/Android/Flutter build toolchain live
together, so builds run as direct subprocesses with no Docker-in-Docker and no sibling containers.

Then open `http://localhost:8000`.

## Project structure

apkit searches the whole archive for one of three root markers — not just the top level — so a
project nested inside a repo folder, a workspace folder, or several layers of wrapping still
builds correctly.

<details>
<summary><strong>Web / Capacitor project</strong></summary>

- `package.json` somewhere in the archive
- No `android/`, `ios/`, or `platforms/` folder in the promoted project root — those are generated
  by the build and can't be safely merged with an existing one
- A `capacitor.config.json`/`.ts` is optional — reused if present, generated if not

</details>

<details>
<summary><strong>Native Android project</strong></summary>

- `settings.gradle`(`.kts`) and a root `build.gradle`(`.kts`)
- The complete Gradle wrapper: `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`,
  `gradle/wrapper/gradle-wrapper.properties` — searched for anywhere in the archive, not just the
  conventional path
- Run `gradle wrapper` before zipping if any of those are missing

</details>

<details>
<summary><strong>Flutter project</strong></summary>

- `pubspec.yaml` at the project root
- An `android/` folder is optional — generated automatically if missing (via
  `flutter create --platforms=android`, which never touches existing files), left completely
  untouched if included
- `ios/` is allowed alongside it; only `android/` is ever built into an APK here
- No Gradle wrapper required — `flutter build apk` manages its own embedded Android build

</details>

**Archive rules:** one project per `.zip`, up to 300 MB (several archives can be dropped at once);
path traversal, absolute paths, and null bytes in entry names are rejected outright; anything not
needed to build the app (editor/OS cruft, unrecognized binaries) is silently skipped rather than
failing the whole upload.

## API reference

All endpoints are namespaced under `/api`; `Content-Type: application/json` except where noted.
Everything besides `/api/auth/*` and `/api/health` requires a bearer token (see
[`app/auth.py`](./app/auth.py)).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | Create an account |
| `POST` | `/api/auth/login` | Exchange credentials for a session token |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET`  | `/api/auth/me` | Current user, from the bearer token |
| `GET`  | `/api/health` | Cheap liveness probe — no disk or job-store access |
| `GET`  | `/api/system` | Live queue depth, running build count, and memory headroom |
| `POST` | `/api/upload` | Upload a `.zip` (`multipart/form-data`), enqueue a build, return a `jobId` |
| `GET`  | `/api/status/{job_id}` | Current status of a build |
| `GET`  | `/api/logs/{job_id}/stream` | Server-Sent Events stream of the live build log |
| `GET`  | `/api/download/{job_id}` | Download the finished `.apk` |
| `POST` | `/api/assist` | Ask the troubleshooting assistant about a failed build |
| `POST` | `/api/visitors/ping` | Record a visit (analytics) |
| `GET`  | `/api/visitors/stats` | Aggregate visitor/country counts |

`EventSource` and plain `<a href>` downloads can't set custom headers, so `/logs/*/stream` and
`/download/*` additionally accept the session token as a `?token=` query parameter.

## Configuration

Everything is environment-driven with sane defaults — see [`app/config.py`](./app/config.py) for
the authoritative list. The most relevant to a first deployment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Port the server listens on (most hosts inject this themselves) |
| `MAX_CONCURRENT_BUILDS` | `2` | Builds run directly in this container — size against real RAM |
| `MIN_FREE_MEMORY_MB` | `512` | Real OOM guard; queued builds wait if available memory drops below this |
| `BUILD_TIMEOUT_MS` | `900000` (15 min) | Per-build wall-clock limit before it's killed |
| `MAX_UPLOAD_BYTES` | `314572800` (300 MB) | Max archive size |
| `JOB_ROOT` | `$TMPDIR/apk-builder-jobs` | Per-job working directories (swept on TTL expiry) |
| `JOB_TTL_MS` | `3600000` (1 h) | How long a finished job's files stay downloadable |
| `APP_ID` / `APP_NAME` | `com.builder.app` / `MyApp` | Defaults used when generating a Capacitor/Flutter Android shell |
| `CAPACITOR_MAJOR` | `7` | Capacitor major version installed for web/Capacitor builds |
| `FLUTTER_BUILD_MODE` | `debug` | `flutter build apk` mode — `release` requires your own signing config |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins, if the dashboard is ever split out |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `10` / `600000` | Per-IP upload rate limit |
| `ANTHROPIC_API_KEY` | unset | Enables model-generated (vs. rule-based) troubleshooting answers |
| `GEOIP_LOOKUP_URL` | `ip-api.com` | Visitor country lookup; set to `""` to disable |

Shared build-cache directories (`NPM_CACHE_DIR`, `GRADLE_RO_DEP_CACHE`,
`GRADLE_SHARED_BUILD_CACHE_DIR`, `GRADLE_DIST_CACHE_DIR`, `DEP_CACHE_DIR`, `PUB_CACHE_DIR`) and the
analytics/auth database paths (`VISITOR_DB_PATH`, `AUTH_DB_PATH`) all have working defaults under
the system temp dir and only need overriding for a custom persistent-volume layout.

## Architecture

```
app/
  main.py                          FastAPI app assembly, CORS, static hosting, error handling
  routes.py                        Build/upload/status/logs/download endpoints, rate limiting
  auth.py / auth_routes.py         Accounts, sessions, bearer-token auth
  config.py                        Central settings, env-var driven
  job_store.py                     In-memory job registry + async pub/sub for log streaming
  validate.py                      Archive safety checks, extraction, project-type detection
  build_runner.py                  Build queue, memory admission control, the build pipeline itself
  permissions.py                   Android permission allowlist/sanitizer
  dep_cache.py                     Content-addressed node_modules hardlink cache
  assist.py                        AI-assisted (+ rule-based fallback) build troubleshooting
  db.py / visitors.py              SQLite-backed visitor/country analytics
  shared-build-cache-init.gradle   Gradle init script wiring up the shared build cache
web/                                React dashboard (Vite), built to web/dist and served statically
requirements.txt
Dockerfile                          One image: Python server + Node/JDK/Android SDK/Flutter SDK
```

**Build pipeline, end to end:**

1. `POST /api/upload` streams the archive to disk under a rate/size limit, then hands it to
   `validate.py`.
2. `validate.py` rejects unsafe paths, searches the whole archive for a project-type marker,
   extracts only allowlisted file types, promotes a nested project root to the top if needed, and
   — for native Android — confirms the complete Gradle wrapper is present.
3. `build_runner.py` queues the job behind `MAX_CONCURRENT_BUILDS` and a real free-memory check,
   then runs the appropriate build path as an isolated subprocess tree (its own process group, so
   a timeout can kill every forked JVM/Gradle worker with it), patching in only the permissions
   that were explicitly requested.
4. Every line of subprocess output is streamed to the job's log as it happens, broadcast live over
   `/api/logs/{job_id}/stream`.
5. On success the built APK is copied to the job's output directory and served from
   `/api/download/{job_id}` until the job's TTL expires.

**Design choices worth knowing about:**

- **Concurrency**: a single asyncio event loop plus a small per-job `asyncio.Queue` fan-out
  (`job_store.EventBus`) — no threads, no extra processes. `MAX_CONCURRENT_BUILDS` and the memory
  admission check both reason about this one process's actual resource usage.
- **Subprocess isolation**: every build subprocess starts its own process group
  (`start_new_session=True`), so a timeout can `killpg()` the whole tree — including whatever JVM
  worker processes Gradle itself forks — rather than leaving orphans behind.
- **Caching, layered correctly**: the Gradle *dependency* cache, the Gradle *build* cache, the
  wrapper's own *distribution* download, npm's cache, and Flutter's pub cache are five genuinely
  different things that must **not** share a directory with `GRADLE_USER_HOME` (which stays
  per-job, since Gradle's daemon registry can't safely be shared across concurrent builds) — see
  the comments in `build_runner.py` for the full reasoning.
- **Manifest patching is additive-only**: requested Android permissions are matched against a
  fixed allowlist (`permissions.py`) and appended to `AndroidManifest.xml` if not already present;
  nothing else in the uploaded project is ever modified.
- **Auth is token-based, not cookie-based**: the dashboard can be pointed at a fallback API host,
  and a cookie set for one origin doesn't travel to another — a bearer token in `localStorage`
  does.
