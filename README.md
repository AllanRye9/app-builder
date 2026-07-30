# apk-builder

Turns an uploaded React project zip into a downloadable debug APK. Drop in as many project
archives as you like — each is tracked independently on a live dashboard, and builds run
side by side rather than one at a time.

## This is just a Dockerfile — that's the whole point

Everything — the Express server, the React dashboard, and the full Android build toolchain (JDK
21, Android SDK, Node 22, Gradle) — lives in **one image**, built from the single `Dockerfile` at
the repo root. There's no host Docker socket, no sibling containers, no cloud-specific storage
API, and no platform-specific glue code anywhere in `src/` or `web/`. Builds run as direct
subprocesses inside this same container (`src/buildRunner.js`), not by shelling out to `docker
run` — which is *why* this has no platform dependency: nothing here assumes access to anything
beyond "a container that can run a Node process and listen on a port."

Concretely, that means the exact same image runs unmodified on:

- Your own machine (`docker compose up`)
- A bare VPS (`docker compose up -d`, or plain `docker build && docker run`)
- Render, Railway, Fly.io, Google Cloud Run, AWS App Runner/ECS, DigitalOcean App Platform, or any
  other host that can build and run a Dockerfile

The only thing that ever changes between them is which env vars you set and how you point DNS at
it — never the code.

```
Browser (React dashboard)
   │  drop N .zip files → each tracked as its own job/ticket
   │  live per-job logs + queue position over SSE, toast on completion/error
   ▼
Express server (src/) — one process
   │  validate zip → extract → bounded queue (MAX_CONCURRENT_BUILDS)
   ▼
src/buildRunner.js — runs each build as direct subprocesses, in this same container
   │  npm install → npm run build → cap add android → gradlew assembleDebug
   ▼
app.apk served for download from this same server
```

## Running it anywhere: the one universal path

```bash
git clone <this repo>
cd apk-builder
docker compose up -d
```

Open `http://localhost:3000` (or whatever port you mapped). That's the entire setup, on any
machine with Docker installed — a laptop, a $5 VPS, or a cloud platform's build step. Everything
below this point is optional convenience for specific platforms, not a requirement.

## Sizing — the one thing to actually pay attention to, everywhere

Every build's CPU and memory comes directly out of **this one container's** resources — there's no
per-job isolation (that would require sibling containers, which is exactly the platform-specific
thing this version avoids). Gradle + the Android Gradle Plugin alone routinely use 1.5-2.5GB per
concurrent build.

- `MAX_CONCURRENT_BUILDS` defaults to **2**. This is a real ceiling, not a suggestion — raising it
  without also sizing up your host's RAM will cause builds to fail or the whole container to get
  OOM-killed under load.
- A reasonable baseline anywhere: **2GB RAM minimum**, comfortably handles `MAX_CONCURRENT_BUILDS=2`.
  Go up from there before raising concurrency further.

## Environment variables

All optional, all have defaults in `src/config.js`:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Most platforms inject this themselves — leave it unless running bare |
| `MAX_CONCURRENT_BUILDS` | `2` | See sizing note above |
| `BUILD_TIMEOUT_MS` | `900000` (15 min) | Kills the whole build if any step hangs |
| `MAX_UPLOAD_BYTES` | `314572800` (300MB) | Max accepted zip size |
| `JOB_TTL_MS` | `3600000` (1 hr) | How long a finished job's files stick around |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `10` / `600000` | Per-IP upload rate limit |
| `APP_ID` / `APP_NAME` | `com.builder.app` / `MyApp` | Baked into every generated APK |
| `CORS_ORIGIN` | `*` | Only matters if you split the frontend out to a separate static host |
| `JOB_ROOT` | `/tmp/apk-builder-jobs` | Where job workspaces live — ephemeral by design, see below |

## Job storage is deliberately ephemeral

Job workspaces live under `/tmp` and are meant to be temporary: `jobStore.js`'s own TTL sweep
(default 1 hour) and post-download cleanup remove them automatically. Most container platforms
reset the filesystem on every deploy/restart anyway — this design works *with* that instead of
fighting it with a persistent volume you'd have to manage. Nothing here depends on files surviving
a restart.

## The Android SDK download — the one external version pin

The Dockerfile downloads a specific, pinned build of Android's command-line tools from Google's
CDN (`CMDLINE_TOOLS_VERSION` build arg). Google does occasionally retire old build numbers. If the
image build ever fails specifically at the `curl ... commandlinetools-linux-...` step:

1. Check [developer.android.com/studio#command-line-tools-only](https://developer.android.com/studio#command-line-tools-only) for the current filename.
2. Rebuild with `docker build --build-arg CMDLINE_TOOLS_VERSION=<new number> .` (or edit the `ARG`
   line directly).

This is deliberately the *only* place in the whole setup with a hardcoded external version — kept
isolated on purpose so it's a one-line fix if it ever goes stale, not a mystery buried in a build
log, and it's the same fix regardless of which platform you're running this on.

## Platform quick-starts

Each of these is a thin, optional layer over the exact same image — pick the one relevant to you,
ignore the rest. None of them are required for the app to work.

<details>
<summary><strong>Render</strong></summary>

**Use Blueprint, not manual service creation.** `render.yaml` declares `runtime: docker` in code
— **New → Blueprint**, point it at this repo, and Render reads the runtime from that file
directly. Manual **New → Web Service** creation makes you pick the runtime from a dropdown
yourself, and Render's auto-detect defaults to treating a repo with a `package.json` as a plain
Node app if you don't catch that — which silently ignores the Dockerfile entirely and tries to run
`src/index.js` with none of the build steps ever having happened. If you ever see `Cannot find
module '/app/src/index.js'` on Render specifically, check **Settings → Runtime** first — if it says
"Node" instead of "Docker", that's the whole bug, and the fix is deleting and recreating the
service with Docker explicitly selected (Render doesn't allow changing Runtime after creation).
</details>

<details>
<summary><strong>Railway</strong></summary>

Railway auto-detects the Dockerfile with zero config. `railway.json` is included to pin the health
check path explicitly, but isn't required. **New Project -> Deploy from GitHub repo**.
</details>

<details>
<summary><strong>Fly.io</strong></summary>

`fly.toml` is included with a sizing-appropriate VM already configured. `fly launch` (it'll detect
the existing config) or `fly deploy` directly.
</details>

<details>
<summary><strong>Google Cloud Run / AWS App Runner / DigitalOcean App Platform</strong></summary>

No config file needed — all three build directly from a Dockerfile with no extra setup. Point them
at this repo, leave the Dockerfile path as default (repo root), and set the env vars above through
each platform's own dashboard. Make sure whichever plan/tier you pick meets the sizing note above.
</details>

<details>
<summary><strong>Bare VPS (no orchestration platform at all)</strong></summary>

```bash
docker compose up -d
```

Put a reverse proxy (Caddy, Nginx, or Cloudflare Tunnel) in front for TLS. That's the entire setup
— same image, same env vars, same everything as every other option above.
</details>

## Splitting the frontend out (optional, rarely needed)

By default this one service serves both the dashboard and the API. If you ever want the frontend
on a separate static host instead, set `VITE_API_BASE_URL` (in `web/`) to this backend's URL, and
set `CORS_ORIGIN` on the backend to the frontend's origin. Not needed for the default single-service
setup described above.
