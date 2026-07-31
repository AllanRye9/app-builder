# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React frontend
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: production server
# ---------------------------------------------------------------------------
# This is a plain Express server (server/index.js) serving the built
# frontend and the /api/* routes — no Docker-in-Docker, no docker.sock
# mount. The actual Android build happens on a GitHub Actions runner
# (see .github/workflows/build-apk.yml), dispatched via the GitHub API.
FROM node:20-alpine AS app
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
# Render sets $PORT itself and routes traffic to it; server/index.js reads
# process.env.PORT with a fallback for local/non-Render use. This is the
# one setting still read from an env var — see the comment in
# server/index.js for why (Render/Railway/Fly assign it dynamically per
# instance, so it can't live in a static config file).

# All other settings (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
# CALLBACK_SECRET, DATA_DIR) come from config.json instead of env vars —
# see config.example.json. This image intentionally does NOT COPY a
# config.json in (secrets shouldn't be baked into an image layer); supply
# it at container run time instead:
#   docker run -v $(pwd)/config.json:/app/config.json -p 3000:3000 <image>
# On Render, attach a Disk and drop config.json at its mount path (e.g.
# /data/config.json) via the platform's shell — server/config.js checks
# /data/config.json automatically.

EXPOSE 3000
CMD ["node", "server/index.js"]
