# apk-builder (Render edition)

Turns a React project zip into a downloadable debug APK. This version runs as a **single Docker
service on Render** — one container has the Express server, the React dashboard, and the full
Android build toolchain (JDK 21, Android SDK, Gradle) all in one image.

## Why this is a different architecture from the VPS/docker-compose version

The original version span up a **sibling** Docker container per build (`docker run ...`) by
talking to the host's Docker daemon. That requires either a real VPS with Docker installed, or a
mounted `/var/run/docker.sock` — neither of which Render (or Vercel, or most PaaS platforms)
exposes to a service. Trying to deploy that version here produces exactly the kind of failure you
just hit: the image either can't find the Docker socket at all, or (as happened) the Dockerfile
built for that architecture doesn't even match this project's layout.

The fix isn't a workaround for that constraint — it's a different, equally valid architecture:
**the build toolchain lives in the same container as the app**, and `src/buildRunner.js` runs each
build as a direct subprocess (`npm install`, `npm run build`, `npx cap add android`,
`./gradlew assembleDebug`) instead of spawning a sibling container. Same build steps, same
dashboard, no socket required.

```
Render Web Service (one Docker container)
├── Express server (src/) — serves the React dashboard as static files + the API
├── React dashboard (web/) — same multi-job ticket UI as before
└── Build toolchain (JDK 21, Android SDK, Node 22, Gradle) — baked into the same image
        │
        ▼
   src/buildRunner.js spawns build steps as direct subprocesses per job,
   bounded by MAX_CONCURRENT_BUILDS, all sharing this one container's CPU/RAM
```

## Deploying

### Option A: Blueprint (one click)

This repo includes `render.yaml`. In Render: **New → Blueprint**, point it at this repo, and it
reads the service definition automatically — plan, health check, env vars are all pre-filled.

### Option B: Manual

**New → Web Service** → connect this repo → set:
- **Runtime**: Docker
- **Dockerfile Path**: `./Dockerfile`
- **Root Directory**: leave blank (repo root) — this is the most common cause of a "Cannot find
  module" crash like the one that led here: if Root Directory points anywhere other than where
  this `Dockerfile` and `src/` actually live in your repo, the build context won't include them.

## Sizing — this is the one thing that's genuinely different from before

Every build's CPU and memory now comes directly out of **this one container's** resources — there's
no more per-job Docker `--memory`/`--cpus` cap, because there's no more sibling container to cap.
Gradle + the Android Gradle Plugin alone routinely use 1.5–2.5GB per concurrent build.

- `MAX_CONCURRENT_BUILDS` defaults to **2**. Don't raise it without also sizing up the Render plan
  — this is a real ceiling, not a suggestion. Render's **Standard** plan (2GB RAM) comfortably
  handles 1–2 concurrent builds; go **Pro** or higher before raising this further.
- Job workspaces live in `/tmp` (ephemeral, cleared on every deploy/restart) — this is intentional,
  not a gap. They're meant to be temporary; `jobStore.js`'s own TTL sweep and post-download cleanup
  already handle removing them during normal operation.

## Environment variables

All optional, all have defaults in `render.yaml` / `src/config.js`:

| Variable | Default | Notes |
|---|---|---|
| `MAX_CONCURRENT_BUILDS` | `2` | See sizing note above — this is a hard shared-resource ceiling now |
| `BUILD_TIMEOUT_MS` | `900000` (15 min) | Kills the whole build if any single step hangs |
| `MAX_UPLOAD_BYTES` | `314572800` (300MB) | Max accepted zip size |
| `JOB_TTL_MS` | `3600000` (1 hr) | How long a finished job's files stick around |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `10` / `600000` | Per-IP upload rate limit |
| `APP_ID` / `APP_NAME` | `com.builder.app` / `MyApp` | Baked into every generated APK — same for all uploads by default |
| `CORS_ORIGIN` | `*` | Only matters if you split the frontend out separately later |

## The Android SDK download — the one external version dependency

The Dockerfile downloads a specific, pinned build of Android's command-line tools from Google's
CDN (`CMDLINE_TOOLS_VERSION` build arg, defaulting to `11076708`). Google does occasionally retire
old build numbers. If the image build ever fails specifically at the
`curl ... commandlinetools-linux-...` step:

1. Check [developer.android.com/studio#command-line-tools-only](https://developer.android.com/studio#command-line-tools-only) for the current filename.
2. In Render → your service → **Environment** → add a build arg, or edit the `ARG
   CMDLINE_TOOLS_VERSION` line in the Dockerfile directly and redeploy.

This is deliberately the *only* place in the whole setup with an external version pin like this —
kept isolated here on purpose so it's a one-line fix if it ever goes stale, not a mystery buried in
a build log.

## What's genuinely different from the previous versions

- **No live Docker log streaming quirks to fight** — since builds run as direct subprocesses in
  this same process (not an external container we parse `##NOTICE##` markers out of),
  `buildRunner.js` calls the job log/status functions directly at each step. Simpler and more
  robust than the Docker version's approach, not just a substitute for it.
- **Render auto-deploys on push** (if enabled, which it is by default for a connected repo) — so
  the "fixed the code but never redeployed" failure mode that caused most of the pain in the
  VPS/docker-compose version is structurally much less likely here, though not impossible (you can
  still disable auto-deploy or push to the wrong branch).
- **No per-job resource isolation** — the real trade-off versus the Docker-orchestrator version.
  Mitigated by `MAX_CONCURRENT_BUILDS` and `BUILD_TIMEOUT_MS`, but a single runaway build can still
  affect others sharing the container. Acceptable for moderate volume; genuinely worth reconsidering
  a dedicated-VM-per-build architecture if this needs to scale to heavy concurrent load.
