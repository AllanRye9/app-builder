# apk-builder

Upload a `.zip` of a React (or Capacitor-ready) project → get back a downloadable debug APK. Every build runs inside a disposable, resource-capped Docker container with a pre-configured Android SDK, so licenses, `ANDROID_SDK_ROOT`, and Gradle are already sorted — nothing to configure per build.

```
Browser (public/index.html)
   │  upload .zip, watch live logs over SSE
   ▼
Express backend (server.js)
   │  validate zip → extract → queue → spawn `docker run`
   ▼
Ephemeral Docker container (Dockerfile + build.sh)
   │  npm install → npm run build → cap add android → gradlew assembleDebug
   ▼
app.apk copied to a mounted output volume → served for download
```

## 1. Prerequisites

- Node.js 18+
- Docker Engine, running and reachable by the user that runs the backend (the backend shells out to the `docker` CLI, so no separate Docker SDK is required)

## 2. Build the build image (once)

```bash
docker build -t apk-builder-image .
```

This image bundles JDK 17, the Android SDK command-line tools (with licenses pre-accepted and `platform-tools`, `android-35`, and `build-tools;34.0.0` pre-installed), Node 20, Gradle, and the Capacitor CLI. Rebuild it whenever you want to bump SDK/Gradle/Node versions.

## 3. Install and run the backend

```bash
npm install
npm start
```

The server listens on `http://localhost:3000` by default and serves the upload UI at `/`.

## 4. Configuration

All optional, set as environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DOCKER_IMAGE` | `apk-builder-image` | Image tag to run per build |
| `MAX_CONCURRENT_BUILDS` | `1` | How many Docker builds run in parallel |
| `BUILD_MEMORY_LIMIT` | `2g` | `--memory` cap passed to `docker run` |
| `BUILD_CPU_LIMIT` | `2` | `--cpus` cap passed to `docker run` |
| `BUILD_TIMEOUT_MS` | `900000` (15 min) | Kill the container if a build hangs |
| `MAX_UPLOAD_BYTES` | `157286400` (150 MB) | Max accepted zip size |
| `JOB_ROOT` | OS temp dir | Where per-job workspaces are extracted |
| `JOB_TTL_MS` | `3600000` (1 hr) | How long a finished job's files stick around before cleanup |

## What gets validated before a build ever starts

- Archive must contain a root-level `package.json`.
- Archive is rejected if it already contains `android/`, `ios/`, `platforms/`, `capacitor.config.json`, or `capacitor.config.ts` — the build generates the native project itself.
- Every file entry is checked against an allowlist of source-file extensions (`.js`, `.ts`, `.tsx`, `.css`, `.json`, images, fonts, etc.) — anything outside that list fails validation rather than being silently dropped.
- Zip-slip protection: any entry path that resolves outside the extraction directory is rejected.

## API

- `POST /api/upload` — multipart form, field name `zip`. Returns `{ jobId }`.
- `GET /api/status/:jobId` — current status, error (if any), and full log history.
- `GET /api/logs/:jobId/stream` — Server-Sent Events stream of log lines plus `status`/`done` events.
- `GET /api/download/:jobId` — streams `app.apk` once the job succeeds.

## Notes on isolation

- Each build runs in its own container, started with `--rm` (destroyed on exit) and capped `--memory`/`--cpus`.
- The container **does** need outbound network access — `npm install` and the first `cap add android` pull from the npm registry and Google's Maven/Gradle distribution — so it isn't network-isolated. Isolation comes from the container being ephemeral and resource-limited, not network-air-gapped.
- Per-job workspaces live under `JOB_ROOT` and are deleted automatically after `JOB_TTL_MS`.

## Production deployment notes

- Put this behind a reverse proxy (e.g. Nginx) that allows large request bodies (`client_max_body_size` ≥ your `MAX_UPLOAD_BYTES`) and doesn't buffer the SSE log stream (`proxy_buffering off` on the `/api/logs/*` location).
- The in-memory job store (`jobs` Map in `server.js`) is single-instance only. If you need to run more than one backend replica, move job state to Redis/Postgres and keep only one instance polling/spawning Docker builds, or use a real job queue (BullMQ, etc.).
- Consider building release (signed) APKs instead of `assembleDebug` for anything beyond internal testing — that requires mounting a keystore into the container and switching `build.sh` to `assembleRelease`, which is intentionally left out here since it involves secret handling.
