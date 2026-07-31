# apk-builder (server + GitHub Actions edition)

Turns a React project zip into a downloadable debug APK. This version runs on **one long-running
Node/Express server and GitHub Actions** — no separate serverless platform required, no Docker
daemon to keep running on your own box:

- **The server** (`server/index.js`) serves the dashboard (built React app) and handles a handful
  of small API routes. It's plain Express, so it runs anywhere that can run a Node process —
  Render, Railway, Fly.io, a plain VPS with Docker, or (with caveats — see below) Vercel.
- **GitHub Actions** does the actual build, on a brand-new Ubuntu runner every single time.

That second point is the whole reason this version exists: every previous failure in getting this
working traced back to a persistent server running stale code after a fix was made but never
redeployed. A GitHub Actions runner can't go stale — it's provisioned fresh from
`.github/workflows/build-apk.yml` on every run, so whatever is committed to that file *is* what
runs, always.

Configuration lives in a `config.json` file (see `config.example.json`) rather than environment
variables — it's one file you can open and see exactly what's set, and editing it takes effect
immediately without a restart. The server also has a built-in self-check: `GET /api/config` reports
exactly which config fields (if any) are missing and whether it found a writable storage directory,
and the dashboard shows a banner up front if something's not configured yet — instead of you only
finding out on your first upload.

```
Browser (this app)
   │  1. POST /api/upload-and-start — multipart upload of the .zip straight
   │     to this server (a real long-running process, no 4.5MB body cap)
   ▼
server/index.js (Express, one process)
   │  saves the zip to DATA_DIR, creates a job id, dispatches GitHub Actions
   │  status kept in memory + mirrored to DATA_DIR so /api/status polling
   │  survives this process staying up between requests
   ▼
.github/workflows/build-apk.yml (fresh GitHub-hosted Ubuntu runner)
   │  JDK 21, Node 22, Android SDK → npm install → npm run build →
   │  cap add android → gradlew assembleDebug
   │  reports progress back via curl to /api/build-progress and
   │  /api/build-complete, and posts the finished APK to /api/upload-apk
   ▼
Browser polls /api/status?jobId=... every 3s, shows a download link
   once apkUrl is set
```

## One-time setup

### 1. Push this to a GitHub repo

Public or private both work. Public repos get **unlimited** free GitHub Actions minutes; private
repos get 2,000 free minutes/month (a typical build takes 3–6 minutes).

### 2. Create a GitHub token

Fine-grained personal access token ([github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)),
scoped to just this repo, with:
- **Contents**: Read and write
- **Actions**: Read and write

(Needed for the `POST /repos/{owner}/{repo}/dispatches` call in `server/index.js`.)

### 3. Deploy to Render

Easiest path: **New → Blueprint** in the Render dashboard, point it at this repo — `render.yaml`
sets up the web service (Docker runtime, from the root `Dockerfile`), a 1GB persistent disk mounted
at `/data`, and generates `CALLBACK_SECRET` for you automatically.

Without the Blueprint: **New → Web Service**, runtime **Docker**, root directory the repo root. Add
a Disk (Settings → Disks) mounted at `/data` if you want jobs to survive restarts — optional but
recommended.

### 4. Create config.json on the mounted Disk

Render dashboard → your service → **Shell** tab, then:

```bash
cat > /data/config.json <<'EOF'
{
  "githubToken": "the token from step 2",
  "githubOwner": "your GitHub username or org",
  "githubRepo": "this repo's name",
  "callbackSecret": "any random string, e.g. output of `openssl rand -hex 32`",
  "dataDir": "/data"
}
EOF
```

`server/config.js` checks `/data/config.json` automatically — no restart needed, it's read fresh
on every request. `callbackSecret` and `dataDir` both have safe automatic fallbacks if you leave
them out (see `config.example.json`), but `githubToken`/`githubOwner`/`githubRepo` are genuinely
required.

Once created, visit `https://<your-service>.onrender.com/api/config` (or just open the app —
it shows the same thing as a banner) to confirm the server sees everything it needs.

### Deploying elsewhere

The server (`server/index.js`) is plain Express — it doesn't need Render specifically, only a
platform that runs a **persistent Node process with a writable filesystem**, since it tracks
in-flight jobs in memory and stores uploaded zips/APKs on disk. The same four `config.json` fields
from step 4 apply everywhere; each platform just has a different way of getting the file onto disk.

- **Railway / Fly.io / a plain VPS with Docker**: build from the root `Dockerfile` (same one Render
  uses), attach a persistent volume, and put `config.json` on it (bind-mount it in, or shell in and
  create it the same way as the Render step above) — point `dataDir` at the same volume. Without a
  volume, this still runs — job status/uploads/APKs just don't survive a restart, and you'd bind-mount
  `config.json` in directly instead: `docker run -v $(pwd)/config.json:/app/config.json ...`.

- **Vercel**: this repo includes `api/index.js` and `vercel.json` so a `vercel deploy` will boot
  without crashing, but be aware of real limitations before relying on it:
  - Vercel Functions have no persistent writable filesystem to drop a `config.json` onto at
    runtime, so this repo's `vercel.json` build step (`scripts/generate-config.mjs`) generates one
    at **build time** instead, from `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO`/`CALLBACK_SECRET`
    set under Project Settings → Environment Variables — that's the one place in this app env vars
    are still used, purely as a build-time bridge into the config file the server actually reads.
  - Vercel Functions only have a writable `/tmp`, and it's **not guaranteed to persist between
    invocations** — `dataDir` automatically falls back to a temp directory here, but uploaded
    zips, job status, and finished APKs can disappear between requests on a cold start. Fine for
    kicking the tyres; not fine for real use without wiring in external storage (S3, Vercel Blob,
    a database) in place of the local-disk approach this app uses.
  - Vercel's default request body size limit is smaller than the 200MB this app allows for project
    zips on a real always-on server.
  - For anything beyond quick testing, Render/Railway/Fly (a real persistent process + disk) is a
    better fit for how this app is built.

## Local development

```bash
npm install
cp config.example.json config.json   # fill in githubToken, githubOwner, githubRepo
                                      # (callbackSecret/dataDir are optional — sane defaults
                                      # kick in if you leave them blank)
npm run build   # or: npm run dev, in a second terminal, for the Vite dev server with hot reload
npm start
```

`server/config.js` reads `./config.json` fresh on every request — edit the file and the change
takes effect immediately, no restart needed.

`npm run dev` alone only runs the Vite dev server (proxying `/api` to `:3000`) — `npm start` is
what actually runs `server/index.js` and serves the `/api/*` routes.

## Known trade-offs

- **No live raw log streaming.** Instead of tailing build output line-by-line, the dashboard shows
  coarse phase progress (validating/building/done) and a link straight to the GitHub Actions run
  for the full log — GitHub's own log viewer is genuinely better for this than reinventing it.
- **20-minute build timeout**, set in the workflow file. Raise `timeout-minutes` if a project
  legitimately needs longer (GitHub's own hard ceiling is 6 hours).
- **Default app id/name** (`com.builder.app` / `MyApp`) are hardcoded in the workflow's `env:`
  block — edit those two lines if you want them configurable per upload instead.
- **Web build output directory** is auto-detected (`dist`, `build`, `www`, or `out`) — if your
  project uses something else, add it to the list in the "Detect web build output directory" step.
- **Without a Render Disk**, job status/uploads/APKs live only in the running container and are
  lost on redeploy or restart — fine for light use, attach a Disk (see step 3) if that matters.
- **Missing/invalid config no longer crashes the server.** `githubToken`/`githubOwner`/
  `githubRepo` are genuinely required (there's no way to auto-generate a GitHub token), so
  uploads fail with a clear error until they're set — but the server itself boots and `/api/config`
  reports exactly what's missing. `callbackSecret` and `dataDir` both have safe automatic
  fallbacks if left unset, as described above.
