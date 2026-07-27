# apk-builder

Upload a `.zip` of a React (or Capacitor-ready) project → get back a downloadable debug APK.
Every build runs inside a disposable, resource-capped Docker container with a pre-configured
Android SDK, so licenses, `ANDROID_SDK_ROOT`, and Gradle are already sorted — nothing to
configure per build.

```
Browser (React app, web/)
   │  upload .zip, watch live logs over SSE
   ▼
Express backend (src/)
   │  validate zip → extract → queue → spawn `docker run`
   ▼
Ephemeral Docker container (docker/android-build/)
   │  npm install → npm run build → cap add android → gradlew assembleDebug
   ▼
app.apk copied to a mounted output volume → served for download
```

## Project layout

```
apk-builder/
├── docker-compose.yml        # single-command startup
├── Dockerfile                 # app image: builds web/, runs the Express server
├── src/                        # Express backend
│   ├── index.js                #   entry point
│   ├── config.js               #   env-driven settings (incl. HOST_JOB_ROOT, see below)
│   ├── jobStore.js             #   in-memory job records + log/event bus
│   ├── validate.js             #   zip validation & safe extraction
│   ├── dockerRunner.js         #   spawns the sibling build container
│   └── routes.js               #   /api/upload, /api/status, /api/logs, /api/download
├── web/                         # React frontend (Vite)
│   └── src/
│       ├── App.jsx
│       ├── api.js
│       └── components/         #   Dropzone, Pipeline, LogPanel, DownloadCard, ErrorBanner
└── docker/android-build/       # the Android/Capacitor build image
    ├── Dockerfile
    └── build.sh
```

## Run it — one command

```bash
docker compose up --build
```

That's it. This single command:

1. Builds `apk-builder-android` — the Android/Capacitor build environment (JDK 17, Android SDK,
   Gradle, Node 22, Capacitor CLI). It's only ever *built*, never run as a long-lived container —
   `docker compose` builds the image and exits immediately, satisfying it as a dependency.
2. Builds `apk-builder-app` — the React frontend plus the Express server — and starts it.
3. Serves the UI at **http://localhost:3000**.

Each APK build after that spins up a fresh `apk-builder-android` container on demand, capped on
CPU/memory, and destroyed when it finishes.

## Dynamic version handling (no hand-maintained pins)

This runs unattended on a server, so nothing about Capacitor's own versioning is hardcoded:

- **Node**: the image ships a Node 22 baseline, but `build.sh` reads the installed Capacitor
  CLI's own declared `engines.node` requirement at the start of every build and, if it's ever
  insufficient, installs a newer Node on the fly with `n` and continues — no image rebuild.
- **Capacitor CLI**: installed at `@latest` in the Dockerfile, deliberately not pinned.
- **`@capacitor/core` / `@capacitor/android`**: `build.sh` reads whichever CLI version actually
  landed in the image and installs matching platform packages to that same major version, every
  build — so these three can never drift out of sync with each other.
- **Missing-dependency errors** (e.g. `cap add android` refusing to run without
  `@capacitor/android` installed first): a generic wrapper (`run_cap_step` in `build.sh`) parses
  any `npm install <package>` suggestion the CLI prints on failure, installs it, and retries once
  automatically — this isn't special-cased to the Android-platform error specifically, it applies
  to any Capacitor CLI step that fails with that kind of suggestion.

## Build notifications (pop-ups)

Anything the build decides or fixes dynamically — a version it matched, a package it installed
on the fly, a permission it patched in, a validation rejection — is emitted as a structured
**notice**, separate from the scrolling log text:

```
build.sh  →  "##NOTICE## {\"level\":\"info\",\"title\":\"...\",\"message\":\"...\"}" on stdout
         →  src/dockerRunner.js parses the marker, calls jobStore.notice()
         →  src/routes.js forwards it as an SSE "notice" event
         →  web/src/components/ToastStack.jsx renders it as a dismissible pop-up
```

Levels are `info`, `warning`, `success`, and `error` (errors don't auto-dismiss). To add a new
notice from `build.sh`, just call the existing `notice()` shell function:

```bash
notice "info" "Short title" "Longer explanation of what happened and why."
```

## About the `cd: /project: No such file or directory` error

That error means `build.sh` was asked to `cd` into `/project`, but nothing was bind-mounted
there. Two different situations cause it, and both are fixed here:

**1. Running the build image directly without volumes.** If you run:

```bash
docker run --rm apk-builder-android          # missing -v flags
```

there's nothing at `/project` at all. `build.sh` now checks for this and fails with an explicit
message and the correct command, instead of a bare shell error:

```bash
docker run --rm \
  -v "$(pwd)/my-react-app:/project" \
  -v "$(pwd)/output:/output" \
  apk-builder-android
```

**2. The path-translation trap when the server itself runs in a container.** The Express server
builds APKs by shelling out to `docker run`. When the server is containerized (as it now is, via
the root `Dockerfile`) and talks to the **host's** Docker daemon over a mounted
`/var/run/docker.sock`, that daemon always resolves `-v` bind mounts against the **host**
filesystem — never against the calling container's filesystem. If the server passed its own
in-container job path (e.g. `/workspace/jobs/<id>/project`), the host daemon would look for that
exact path *on the host*, not find it, and either error out or mount an empty directory — which
is exactly what produces this failure.

The fix is `HOST_JOB_ROOT` in `src/config.js` / `src/dockerRunner.js`: the server keeps using its
own in-container path (`JOB_ROOT`) for reading and writing files, but translates that path to the
real host path (`HOST_JOB_ROOT`) whenever it constructs a `-v` flag for a sibling build container.
`docker-compose.yml` wires this up by bind-mounting `./.jobs` (a real host directory) into the app
container at `/workspace/jobs`, and passing the host-side path in as `HOST_JOB_ROOT`.

If you run the server directly on the host (no container, see below), there's no path
translation to do — `HOST_JOB_ROOT` simply isn't set and defaults to `JOB_ROOT`.

## Running without Docker Compose

You can still run the pieces by hand if you prefer:

```bash
# 1. Build the build image (once; rebuild to bump SDK/Gradle/Node versions)
docker build -t apk-builder-android:latest docker/android-build

# 2. Build the frontend
npm run build:web

# 3. Install and run the backend directly on the host
npm install
npm start
```

The server listens on `http://localhost:3000` and serves the built React app at `/`.

## Frontend development

For hot-reloading UI work without rebuilding Docker images each time:

```bash
npm start          # terminal 1 — Express API on :3000
npm run dev:web     # terminal 2 — Vite dev server on :5173, proxies /api to :3000
```

## Deploying the frontend on Vercel, Netlify, or any static host

**Only the React app (`web/`) can run on Vercel or a similar serverless/static platform.** The
build worker cannot, and this isn't a configuration gap — it's a hard platform wall:

- Vercel Serverless Functions cap request/response bodies at **4.5 MB**. This app accepts project
  archives up to 150 MB by default.
- Execution time is capped too — 10s on Hobby, up to 800s on Pro/Enterprise with Fluid Compute,
  never unlimited. A real Android build (`npm install` + Vite build + Gradle `assembleDebug`)
  routinely takes minutes.
- There's no Docker daemon available inside a Vercel Function, and nothing to mount a socket into
  — this app's entire build mechanism is spawning sibling Docker containers.

So the split is: **frontend on Vercel (or Netlify, Cloudflare Pages, GitHub Pages, S3+CloudFront,
nginx — anything that serves static files)**, **worker on anything with a real, persistent Docker
daemon** — a VPS, Fly.io, Railway, Render, EC2, or your own machine, using the existing
`docker-compose.yml` unchanged.

Steps:

1. **Deploy the worker** somewhere with Docker, exactly as described above (`docker compose up
   --build`). Note its public HTTPS URL, e.g. `https://build.example.com`. Set `CORS_ORIGIN` on
   the worker (via `.env` or your host's env var settings) to the frontend's eventual origin,
   e.g. `CORS_ORIGIN=https://your-app.vercel.app`.
2. **Deploy `web/` to Vercel** (or another static host): in Vercel's project settings, set **Root
   Directory** to `web`. It auto-detects Vite (a `web/vercel.json` is included for clarity/
   explicit config). Set the environment variable `VITE_API_BASE_URL` to the worker's URL from
   step 1 — see `web/.env.example`.
3. That's it — the deployed frontend talks directly to the worker over CORS for upload, the SSE
   log stream, and download. Vercel never sees the large upload or the long-running build; it's
   purely serving static files.

The same two-part split applies to any other host that only offers static file serving (or a
serverless-functions model) rather than a persistent Docker daemon.

## Configuration

All optional, set as environment variables (or in a `.env` file — see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DOCKER_IMAGE` | `apk-builder-android:latest` | Image tag to run per build |
| `MAX_CONCURRENT_BUILDS` | `1` | How many Docker builds run in parallel |
| `BUILD_MEMORY_LIMIT` | `2g` | `--memory` cap passed to `docker run` |
| `BUILD_CPU_LIMIT` | `2` | `--cpus` cap passed to `docker run` |
| `BUILD_TIMEOUT_MS` | `900000` (15 min) | Kill the container if a build hangs |
| `MAX_UPLOAD_BYTES` | `157286400` (150 MB) | Max accepted zip size |
| `JOB_ROOT` | OS temp dir | Where per-job workspaces are extracted (in-container path) |
| `HOST_JOB_ROOT` | same as `JOB_ROOT` | Real host-side path of `JOB_ROOT`, for DooD bind mounts |
| `JOB_TTL_MS` | `3600000` (1 hr) | How long a finished job's files stick around before cleanup |
| `CORS_ORIGIN` | `*` | Origin(s) allowed to call this worker's API cross-origin (comma-separated); set when the frontend is hosted separately |

Frontend-side (set in `web/.env` / `web/.env.production`, or your static host's env var settings):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | unset (same-origin) | Worker's full URL, when the frontend is deployed separately (Vercel, etc.) |

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
- Mounting `/var/run/docker.sock` gives the app container the ability to control the host's Docker daemon (start/stop any container, not just build containers). That's an inherent tradeoff of the Docker-outside-of-Docker pattern used here to keep the whole stack to one `docker compose up`; if you need stronger isolation, run the backend directly on the host instead (see above) so it talks to the host daemon without a shared socket mount.

## Production deployment notes

- Put this behind a reverse proxy (e.g. Nginx) that allows large request bodies (`client_max_body_size` ≥ your `MAX_UPLOAD_BYTES`) and doesn't buffer the SSE log stream (`proxy_buffering off` on the `/api/logs/*` location).
- The in-memory job store (`jobs` Map in `src/jobStore.js`) is single-instance only. If you need to run more than one backend replica, move job state to Redis/Postgres and keep only one instance polling/spawning Docker builds, or use a real job queue (BullMQ, etc.).
- Consider building release (signed) APKs instead of `assembleDebug` for anything beyond internal testing — that requires mounting a keystore into the container and switching `build.sh` to `assembleRelease`, which is intentionally left out here since it involves secret handling.
