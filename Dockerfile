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
# process.env.PORT with a fallback for local/non-Render use.

# Attach a Render Disk and set DATA_DIR to its mount path in the service's
# environment variables to persist uploads/APKs/status across deploys.
# Without one, this still works but loses in-flight jobs on restart.

EXPOSE 3000
CMD ["node", "server/index.js"]
