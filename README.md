# apk-builder (Render + GitHub Actions edition)

Turns a React project zip into a downloadable debug APK. This version runs on **one Render web
service and GitHub Actions** — no separate serverless platform, no Docker daemon to keep running
on your own box:

- **Render** hosts a single Express server: it serves the dashboard (built React app) and handles
  a handful of small API routes.
- **GitHub Actions** does the actual build, on a brand-new Ubuntu runner every single time.

That second point is the whole reason this version exists: every previous failure in getting this
working traced back to a persistent server running stale code after a fix was made but never
redeployed. A GitHub Actions runner can't go stale — it's provisioned fresh from
`.github/workflows/build-apk.yml` on every run, so whatever is committed to that file *is* what
runs, always.

```
Browser (this app, on Render)
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

### 4. Set the environment variables

Render dashboard → your service → **Environment**:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 2 |
| `GITHUB_OWNER` | your GitHub username or org |
| `GITHUB_REPO` | this repo's name |
| `CALLBACK_SECRET` | only needed if you didn't use the Blueprint — any random string, e.g. `openssl rand -hex 32` |
| `DATA_DIR` | `/data` if you attached a disk, otherwise omit (defaults to local container storage) |

Render redeploys automatically after you save environment variable changes.

## Local development

```bash
npm install
npm run build   # or: npm run dev, in a second terminal, for the Vite dev server with hot reload
GITHUB_TOKEN=... GITHUB_OWNER=... GITHUB_REPO=... CALLBACK_SECRET=... npm start
```

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
