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

The server also has a built-in self-check: `GET /api/config` reports exactly which environment
variables (if any) are missing and whether it found a writable storage directory, and the
dashboard shows a banner up front if something's not configured yet — instead of you only finding
out on your first upload.

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

Once deployed, visit `https://<your-service>.onrender.com/api/config` (or just open the app —
it shows the same thing as a banner) to confirm the server sees everything it needs.

### Deploying elsewhere

The server (`server/index.js`) is plain Express — it doesn't need Render specifically, only a
platform that runs a **persistent Node process with a writable filesystem**, since it tracks
in-flight jobs in memory and stores uploaded zips/APKs on disk. The same `GITHUB_TOKEN`,
`GITHUB_OWNER`, `GITHUB_REPO`, and `CALLBACK_SECRET` variables from step 4 apply everywhere; each
platform just has a different place to set them.

- **Railway / Fly.io / a plain VPS with Docker**: build from the root `Dockerfile` (same one Render
  uses), set the same four env vars in that platform's dashboard/CLI, and attach a persistent
  volume mounted somewhere, then point `DATA_DIR` at it. Without a volume, this still runs — job
  status/uploads/APKs just don't survive a restart.

- **Vercel**: this repo includes `api/index.js` and `vercel.json`, which is what makes Vercel able
  to find and run this app at all — **without them, Vercel's build fails with "No entrypoint
  found"**, because its zero-config Node.js detection only looks for `app`/`index`/`server`
  (`.js`/`.ts`/etc.) at the project root or under `src/`, and this app's real entrypoint is
  `server/index.js`, which doesn't match any of those. `vercel.json` sidesteps that search entirely
  by explicitly declaring `api/index.js` as the Function and rewriting all traffic to it — so if
  you deployed from a copy of this repo that didn't have both those files yet, that's the fix:
  redeploy with them present (they're in this download).

  A few other things to know before relying on Vercel specifically:
  - **Attach a Vercel Blob store, or the zip upload will fail.** Vercel Functions cap request
    bodies at 4.5MB — hard limit, can't be raised — so a plain multipart upload of a real project
    zip never reaches this server's code at all. To get around that, this app automatically
    switches to uploading the zip **directly from the browser to Vercel Blob** (bypassing the
    Function entirely) whenever it detects `BLOB_READ_WRITE_TOKEN` in the environment; `/api/config`
    reports which mode is active as `storageMode: "blob"` or `"disk"`. To turn blob mode on:
    1. Vercel dashboard → your project → **Storage** tab → create a Blob store (or attach an
       existing one).
    2. Connecting a store to your project auto-adds `BLOB_READ_WRITE_TOKEN` as an environment
       variable — confirm it's there under Settings → Environment Variables.
    3. **Redeploy** (see the env var note above — this applies here too).
    4. Check `/api/config` on the new deployment: `storageMode` should say `"blob"`.

    If you see `Upload failed: Vercel Blob: Failed to retrieve the client token`, that error is
    coming from the browser-side upload call itself and almost always means the store isn't
    attached yet or the token hasn't propagated to a fresh deployment — steps 1–4 above are the fix.
  - **The built APK still relays through this server on its way back from GitHub Actions**
    (`/api/upload-apk`), which means it's still subject to that same 4.5MB Function body cap — a
    debug APK bigger than that will fail at the *end* of the build even once the zip upload itself
    works. Most minimal debug APKs are small enough that this doesn't come up, but if you hit it,
    the fix is the same idea as the zip: have `.github/workflows/build-apk.yml` upload the APK
    directly to Blob (using `@vercel/blob`'s `put()`, authenticated with `BLOB_READ_WRITE_TOKEN`
    passed into the workflow) instead of POSTing it to `/api/upload-apk`. That workflow file isn't
    part of this repo/app, so it isn't included here — ask if you want the exact snippet for it.
  - **You must redeploy after adding/changing environment variables.** Setting `GITHUB_TOKEN`,
    `BLOB_READ_WRITE_TOKEN`, etc. in the dashboard does not update an already-built deployment —
    Vercel bakes env vars in at build/deploy time. If uploads still fail with "Failed to dispatch
    build workflow" right after setting them, this is the most common cause: go to Deployments →
    trigger a new one (or push any commit) after saving the variables, then check `/api/config` on
    the *new* deployment URL to confirm it shows `"ready": true`.
  - Environment variables in Vercel are scoped per environment (Production / Preview /
    Development). Make sure you added them to whichever environment you're actually testing —
    a var set only under "Production" won't be visible to a Preview deployment's URL, and vice versa.
  - Without a Blob store attached (`storageMode: "disk"`), Vercel Functions only have a writable
    `/tmp`, and it's **not guaranteed to persist between invocations** — `DATA_DIR` automatically
    falls back to a temp directory here, but uploaded zips, job status, and finished APKs can
    disappear between requests on a cold start. Fine for kicking the tyres in disk mode; attach a
    Blob store (above) for anything real.
  - For anything beyond quick testing, Render/Railway/Fly (a real persistent process + disk) is a
    better fit for how this app is built — Blob mode makes Vercel workable, not equivalent.

  **If uploads still fail with "Failed to dispatch build workflow" after confirming `/api/config`
  shows `"ready": true` on the current deployment:** that message is a generic fallback — the real
  reason (GitHub's actual HTTP status + response body) is saved to that job. The failed upload
  response includes a `jobId`; fetch `/api/status?jobId=<that id>` and read its `error` field. The
  usual causes there are a `GITHUB_OWNER`/`GITHUB_REPO` typo, a token missing repo/Actions
  permissions, or `.github/workflows/build-apk.yml` not being on the repo's default branch.

## Local development

```bash
npm install
cp .env.example .env   # fill in GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (CALLBACK_SECRET/DATA_DIR
                        # are optional — sane defaults kick in if you leave them blank)
npm run build   # or: npm run dev, in a second terminal, for the Vite dev server with hot reload
npm start
```

`server/index.js` loads `.env` automatically (via `dotenv`) if one exists, so you don't have to
prefix every command with env vars — though `GITHUB_TOKEN=... npm start` still works too, and env
vars set that way always take priority over `.env`.

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
- **Missing/invalid env vars no longer crash the server.** `GITHUB_TOKEN`/`GITHUB_OWNER`/
  `GITHUB_REPO` are genuinely required (there's no way to auto-generate a GitHub token), so
  uploads fail with a clear error until they're set — but the server itself boots and `/api/config`
  reports exactly what's missing. `CALLBACK_SECRET` and `DATA_DIR` both have safe automatic
  fallbacks if left unset, as described above.
