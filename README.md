# apk-builder (Docker Compose edition)

Turns a React project zip into a downloadable debug APK. Drop in as many project archives as you
like — each one builds in its own isolated, disposable Docker container with a pre-configured
Android SDK, with live log streaming and a small build queue so uploads never block on each other.

- **`src/index.js`** (Express) serves the dashboard, accepts uploads, validates each project,
  queues/runs its build, and streams progress back over Server-Sent Events.
- **`docker/android-build/`** is the disposable build image (JDK 21, Node 22, Android SDK) — a
  fresh container per job, removed the moment it exits.
- **`docker-compose.yml`** wires the two together: `src/index.js` talks to the **host's** Docker
  daemon over a bind-mounted socket (Docker-outside-of-Docker) to launch build containers as
  siblings, not children, of its own container.
- **Nothing persists.** Each job gets its own directory under `.jobs/`; the build container itself
  is `--rm`'d on exit; and the whole per-job directory (uploaded zip, extracted project, build
  output, finished APK) is deleted automatically `RETENTION_MINUTES` (default 5) after the job
  finishes, success or failure.

```
Browser (the dashboard)
   │  1. POST /api/upload — multipart, field name "zip"
   ▼
src/index.js (Express, one process)
   │  extracts + validates the project (package.json present, no
   │  pre-existing android/ or ios/ folder), queues it behind
   │  MAX_CONCURRENT_BUILDS other builds if needed, then runs:
   ▼
docker run --rm apk-builder-android   (src/dockerRunner.js)
   │  mounts the extracted project at /project (read-write — Capacitor
   │  writes into it) and an empty /output; docker/android-build/build.sh:
   │  npm install → npm run build → cap init/add android →
   │  gradlew assembleDebug → copies app.apk to /output
   ▼
Browser subscribes to GET /api/logs/:jobId/stream (SSE) the moment it has
   a jobId — "message" events are raw log lines, "notice" events are
   dismissible toasts, "status"/"queue" events drive the pipeline stepper,
   a "done" event ends the stream. GET /api/download/:jobId serves the
   APK once status is "success" — then ~5 minutes later, the job's entire
   directory is deleted automatically.
```

## One-time setup

### 1. Install Docker (with Compose)

[docs.docker.com/engine/install](https://docs.docker.com/engine/install/) — `docker compose
version` should succeed.

### 2. Run it

```bash
docker compose up --build
```

This one command builds both images (`apk-builder-android` from `docker/android-build/`, and the
app itself from the root `Dockerfile`, which in turn builds `web/` and copies its output in) and
starts the `app` service. First run is slow — the Android build image downloads several hundred MB
(JDK, Node, Android SDK). Visit `http://localhost:3000`.

`docker-compose.yml` mounts `/var/run/docker.sock` into the `app` container so it can launch
Android build containers as siblings, and mounts `./.jobs` in at `/workspace/jobs` for job data —
see the comments at the top of that file for why `HOST_JOB_ROOT` matters here (it's what makes
Docker-outside-of-Docker work at all: the `app` container's `docker run -v <path>` calls are
actually executed by the **host's** daemon, which can't see paths that only exist inside `app`'s
own container filesystem).

### Running without Docker Compose

You don't strictly need Compose — `src/index.js` is a plain Express process. Build the Android
image once (`docker build -t apk-builder-android docker/android-build`), build the dashboard
(`cd web && npm install && npm run build`), install the root deps (`npm install`), and run
`npm start`. On a bare VPS/local machine (not itself containerized), no `HOST_JOB_ROOT` /
`docker.sock` mount is needed at all — `docker run -v <path>` from a plain host process already
sees the same filesystem as the Docker daemon.

### Deploying to Render

`render.yaml` is included — **New → Blueprint** in the Render dashboard, point it at this repo.

This deploys the dashboard/API (`app` service, Docker runtime, from the root `Dockerfile`) and it
will come up fine, but **actual builds will not work on Render**: Render does not allow privileged
containers or a mounted host Docker socket on any service type (confirmed by Render's own support
— see the comment at the top of `render.yaml`), and this app's build step fundamentally requires
one (Docker-outside-of-Docker, same as the `docker-compose.yml` setup above). `GET
/api/system-status` will report `dockerAvailable: false` there, and uploads will be rejected with
a clear error rather than hanging.

If you want this actually building APKs, deploy it on a host that has Docker installed directly —
a bare VPS or your own machine, via `docker compose up` or the plain `npm start` path above — not
Render (or Vercel, or any platform whose containers can't reach a real Docker daemon).

### Configuration

Everything is an environment variable (see `docker-compose.yml`'s `environment:` block for what's
already set), not a config file:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | What the server listens on |
| `DOCKER_IMAGE` | `apk-builder-android:latest` | Which image to run per build |
| `JOB_ROOT` | OS temp dir | Where this process sees per-job directories |
| `HOST_JOB_ROOT` | *(unset)* | `JOB_ROOT`'s path as seen by the **host** Docker daemon — only needed in the Docker-outside-of-Docker setup `docker-compose.yml` uses |
| `CORS_ORIGIN` | `*` | For running the dashboard on a different origin from the API |
| `MAX_CONCURRENT_BUILDS` | `2` | Builds beyond this queue, with a live position shown in the UI |
| `BUILD_TIMEOUT_MINUTES` | `20` | A build container is killed and the job marked failed past this |
| `RETENTION_MINUTES` | `5` | How long a finished job's files are kept before automatic deletion |
| `DOCKER_BIN` | `docker` | Override if the Docker CLI isn't on `PATH` under this name |

`GET /api/system-status` reports whether the server can actually reach Docker and whether the
build image has been built — worth checking first if uploads are failing immediately.

## Known trade-offs

- **`android/`/`ios/` folders are rejected up front.** The build always generates these fresh via
  `cap add android` — a project that already has one is refused during the "Validate" stage with a
  clear error, rather than silently conflicting later in the build.
- **APK filename is fixed** (`app.apk` inside the container, per `build.sh`) — the download gets a
  nicer name derived from the uploaded zip's filename, but there's one fixed slot per job, not
  per-flavor/variant output.
- **Root-level `src/`, `index.html`, `vite.config.js`, `vercel.json`, `.env.example`, and
  `android-build/`** are leftovers from an earlier iteration of this project (a Vercel + GitHub
  Actions edition, and an older duplicate of `docker/android-build/`) and are **not** used by
  `docker-compose.yml`/the root `Dockerfile` — the actual frontend is `web/`, and the actual build
  image is `docker/android-build/`. They're left in place rather than deleted outright, but if
  you're maintaining this repo going forward, removing them would avoid confusion for whoever
  edits it next.
- **One Docker daemon, one queue.** `MAX_CONCURRENT_BUILDS` caps this one process's own concurrency
  but there's no cross-process/cross-replica coordination — don't run more than one replica of the
  `app` service against the same Docker daemon without accounting for that.
