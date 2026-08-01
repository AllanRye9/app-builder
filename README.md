# apk-builder (Vercel + GitHub Actions edition)

Turns a React project zip into a downloadable debug APK. This version runs on **two managed
platforms and nothing else** — no VPS, no Docker daemon to keep running, no image to rebuild:

- **Vercel** hosts the dashboard (static React app) and a handful of tiny serverless functions.
- **GitHub Actions** does the actual build, on a brand-new Ubuntu runner every single time.

That second point is the whole reason this version exists: every previous failure in getting this
working traced back to a persistent server running stale code after a fix was made but never
redeployed. A GitHub Actions runner can't go stale — it's provisioned fresh from
`.github/workflows/build-apk.yml` on every run, so whatever is committed to that file *is* what
runs, always.

```
Browser (this app, on Vercel)
   │  1. upload .zip directly to Vercel Blob storage (bypasses the 4.5MB
   │     function body limit — see api/blob-upload.js)
   │  2. POST /api/start-build → creates a job id, dispatches GitHub Actions
   ▼
api/*.js (Vercel Serverless Functions)
   │  status persisted as a small JSON blob per job (Functions have no
   │  memory between invocations — see api/_lib/statusStore.js)
   ▼
.github/workflows/build-apk.yml (fresh GitHub-hosted Ubuntu runner)
   │  JDK 21, Node 22, Android SDK → npm install → npm run build →
   │  cap add android → gradlew assembleDebug
   │  reports progress back via curl to /api/build-progress and
   │  /api/build-complete, uploads the finished APK to Blob storage
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

(Needed for the `POST /repos/{owner}/{repo}/dispatches` call in `api/start-build.js`.)

### 3. Deploy to Vercel

Import the repo in Vercel. Root directory is the repo root (not a subfolder).

### 4. Add a Blob store

Vercel project → **Storage** tab → **Create Database** → **Blob**. This automatically sets the
`BLOB_READ_WRITE_TOKEN` environment variable in your Vercel project — you don't set it by hand.

### 5. Set the remaining Vercel environment variables

Project → **Settings** → **Environment Variables**:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 2 |
| `GITHUB_OWNER` | your GitHub username or org |
| `GITHUB_REPO` | this repo's name |
| `CALLBACK_SECRET` | any random string, e.g. `openssl rand -hex 32` |

### 6. Add one secret on the GitHub side

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | Value |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | the **same value** as the Vercel one from step 4 — so the workflow can upload the finished APK to the same Blob store the frontend downloads it from |

(`CALLBACK_SECRET` does *not* need to be a GitHub secret — `api/start-build.js` sends it as part
of the dispatch payload each time, so it only has to exist on the Vercel side.)

### 7. Redeploy

Trigger one more Vercel deployment after adding the env vars (Vercel doesn't retroactively inject
new env vars into an already-built deployment).

That's it — no server to SSH into, ever.

## The one thing that still needs "redeploying"

If you edit `.github/workflows/build-apk.yml` itself, that change only takes effect once it's on
the repo's **default branch** (GitHub only runs the workflow file version that's on default branch
for `repository_dispatch` events, not whatever's on a feature branch). Push/merge to `main` and
you're done — there's no image to rebuild, no container to restart.

## Local development

```bash
npm install
npx vercel dev     # serves both the API functions and the Vite app on :3000
```

(`npm run dev` alone only runs the Vite dev server — the `/api/*` functions need `vercel dev` or a
real Vercel deployment to run at all, since they're not an Express app.)

## Known trade-offs versus a self-hosted worker

- **No live raw log streaming.** Instead of tailing build output line-by-line, the dashboard shows
  coarse phase progress (validating/building/done) and a link straight to the GitHub Actions run
  for the full log — GitHub's own log viewer is genuinely better for this than reinventing it.
- **20-minute build timeout**, set in the workflow file. Raise `timeout-minutes` if a project
  legitimately needs longer (GitHub's own hard ceiling is 6 hours).
- **Default app id/name** (`com.builder.app` / `MyApp`) are hardcoded in the workflow's `env:`
  block — edit those two lines if you want them configurable per upload instead.
- **Web build output directory** is auto-detected (`dist`, `build`, `www`, or `out`) — if your
  project uses something else, add it to the list in the "Detect web build output directory" step.
