# apk-builder (local Docker edition)

Turns a React project zip into a downloadable debug APK. Every upload builds inside its own
short-lived Docker container **on this server's own host** — there's no external CI system, no
GitHub token, no persistent storage to configure. Once a build finishes, the uploaded project, the
build output, and the generated APK are all deleted automatically a few minutes later.

- **The server** (`server/index.js`) is plain Express: it serves the dashboard, accepts uploads,
  and orchestrates builds by shelling out to the `docker` CLI. It needs a real, persistent Node
  process — Vercel-style stateless Functions don't fit this model (see "Deploying" below).
- **The build itself** runs in a container from the `apk-builder-android` image
  (`docker/android-build/`) — JDK 21, Node 22, and the Android SDK, doing the same steps a CI
  pipeline would: `npm install` → `npm run build` → `cap add`/`cap sync android` →
  `gradlew assembleDebug`.
- **Nothing persists between builds.** Each job gets its own temp directory; `docker run --rm`
  means the build container itself is removed the moment it exits; and the whole per-job directory
  (uploaded zip, build output, finished APK) is deleted automatically `retentionMinutes` (default
  5) after the job finishes, whether it succeeded or failed.

Configuration lives in an optional `config.json` file (see `config.example.json`) rather than
environment variables — one file you can open and see exactly what's set, read fresh on every
request so edits take effect immediately without a restart. Every field is optional; sensible
defaults apply if you skip the file entirely. `GET /api/config` reports whether the server can
actually reach a Docker daemon and whether the build image has been built, and the dashboard shows
a banner up front if either isn't ready yet.

```
Browser (this app)
   │  1. POST /api/upload-and-start — multipart upload of the .zip straight
   │     to this server (a real long-running process, no serverless body cap)
   ▼
server/index.js (Express, one process)
   │  saves the zip to an ephemeral per-job temp directory, checks Docker
   │  is reachable and the build image exists, then runs:
   ▼
docker run --rm apk-builder-android   (server/dockerBuild.js)
   │  mounts the uploaded project in read-only, an empty output dir in
   │  writable; the container (docker/android-build/entrypoint.sh) does:
   │  unzip → npm install → npm run build → cap add/sync android →
   │  gradlew assembleDebug → copies app-debug.apk to the output dir
   ▼
Browser polls /api/status?jobId=... every 3s, shows a download link
   once apkUrl is set — then, ~5 minutes later, the job's entire
   directory (upload + output + APK) is deleted automatically
```

## One-time setup

### 1. Install Docker

You need a working Docker installation wherever this server runs — see
[docs.docker.com/engine/install](https://docs.docker.com/engine/install/) for your platform.
`docker version` should succeed in the same shell/environment the server will run in.

### 2. Build the Android build image

```bash
docker build -t apk-builder-android docker/android-build
```

This downloads a few hundred MB (JDK base image, Node, the Android SDK command-line tools and
packages) so it's slow the first time — Docker layer caching makes rebuilds after small edits to
`docker/android-build/entrypoint.sh` fast. Re-run this command any time you change anything under
`docker/android-build/`.

### 3. Run the server

The simplest, most robust setup: run the server **directly on the same host as the Docker daemon**
— a bare VPS or your local machine, not itself wrapped in a container. That way the paths this
server passes to `docker run -v` are valid paths for the Docker daemon to bind-mount, with no
translation needed.

```bash
npm install
npm run build   # builds the dashboard into dist/
npm start        # runs server/index.js, listening on :3000 by default
```

Visit `http://localhost:3000` — the dashboard's setup banner (and `GET /api/config`) will confirm
Docker is reachable and the build image exists.

### Running the server itself in a container too (Docker-out-of-Docker)

If you'd rather run the server in a container as well (e.g. via the root `Dockerfile`), it needs
`/var/run/docker.sock` bind-mounted in so it can launch build containers as siblings:

```bash
docker build -t apk-builder .
docker run \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/apk-builder-jobs:/srv/apk-builder-jobs \
  -v $(pwd)/config.json:/app/config.json \
  apk-builder
```

The extra `-v /srv/apk-builder-jobs:/srv/apk-builder-jobs` bind-mount is important and easy to miss:
in this setup, `docker run -v <path> ...` issued *from inside* the server's container is actually
executed by the **host's** Docker daemon, which can't see paths that only exist inside the server's
own container filesystem. Mount a real host directory in at a fixed path, then in `config.json` set
`workspaceRoot` to that same path and `hostWorkspaceRoot` to the directory's path on the host (in
the example above, both happen to be `/srv/apk-builder-jobs`, but they don't have to match if your
host layout differs) — see `config.example.json` for details. Skip all of this by using the plain
"run directly on the host" setup from step 3 instead, if you can.

### Deploying

Because this server needs a **real, persistent Node process with direct access to a Docker
daemon**, most serverless/stateless hosts don't fit:

- **A VPS or your own machine with Docker installed**: the recommended path — see step 3 above.
- **Railway/Fly.io/similar container platforms**: only works if the platform lets you bind-mount
  `/var/run/docker.sock` into your service's container (uncommon on managed container platforms,
  since it's effectively root access to the host) — check your provider's docs before assuming
  this works. Without socket access, `dockerAvailable` will report `false` and uploads will be
  rejected with a clear error.
- **Render** (`render.yaml` is still included): Render's standard web service runtime does **not**
  expose a Docker socket to your container, so a deploy from this blueprint cannot actually run
  builds. See the comment at the top of `render.yaml`.
- **Vercel** (`api/index.js`/`vercel.json` are still included): Vercel Functions can never reach a
  Docker daemon under any configuration, so this doesn't work there at all. See the comment at the
  top of `api/index.js`.

## Local development

```bash
npm install
docker build -t apk-builder-android docker/android-build   # one-time
npm run build   # or: npm run dev, in a second terminal, for the Vite dev server with hot reload
npm start
```

No `config.json` is required to get started — every field in `config.example.json` has a working
default. Copy it to `config.json` only if you want to override something (a longer build timeout, a
shorter/longer retention window, a differently-named build image, etc.) — it's gitignored, and
`server/config.js` reads it fresh on every request, so edits take effect immediately without a
restart.

`npm run dev` alone only runs the Vite dev server (proxying `/api` to `:3000`) — `npm start` is
what actually runs `server/index.js` and serves the `/api/*` routes.

## Known trade-offs

- **No live raw log streaming.** The dashboard shows coarse phase progress (validating/building/
  done) via the `PHASE:` markers `docker/android-build/entrypoint.sh` prints, not a line-by-line
  log tail. On failure, the last ~15 lines of container output are included in the error message.
- **20-minute build timeout** by default (`buildTimeoutMinutes` in `config.json`) — the container is
  killed and the job marked failed if exceeded. Raise it if a project legitimately needs longer.
- **Default app id/name** (`com.builder.app` / `MyApp`) are hardcoded as `ENV` defaults in
  `docker/android-build/Dockerfile`, used only when the uploaded project doesn't already have a
  `capacitor.config.json`/`.ts` of its own — override at `docker run` time with `-e APP_ID=... -e
  APP_NAME=...`, or edit the Dockerfile, if you want different defaults.
- **Web build output directory** is auto-detected (`dist`, `build`, `www`, or `out`) — if your
  project uses something else, add it to the list in `docker/android-build/entrypoint.sh`.
- **One build at a time isn't enforced.** Concurrent uploads each get their own isolated container
  and job directory and will run in parallel — fine for light use, but there's no queue or
  concurrency limit if you need to cap simultaneous builds on a resource-constrained host.
- **The `docker/android-build` image hasn't been build-tested against a real Android SDK/Gradle
  build as part of producing this project** (no Docker daemon or Google/NodeSource network access
  was available in the environment that wrote it) — the Dockerfile and entrypoint script follow
  well-established patterns, but run `docker build -t apk-builder-android docker/android-build`
  yourself and try an upload before relying on this in production, and check
  `docker/android-build/entrypoint.sh`'s error messages if a build fails unexpectedly.
