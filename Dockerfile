# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React frontend
# ---------------------------------------------------------------------------
FROM node:20-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: production server
# ---------------------------------------------------------------------------
FROM node:20-alpine AS app

# Only the Docker CLI is needed here — this container talks to the *host's*
# Docker daemon over a mounted /var/run/docker.sock (Docker-outside-of-Docker)
# rather than running its own daemon. See src/config.js and
# src/dockerRunner.js for why HOST_JOB_ROOT exists and matters for this setup.
RUN apk add --no-cache docker-cli

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY --from=web-build /web/dist ./web/dist

ENV NODE_ENV=production
ENV JOB_ROOT=/workspace/jobs
RUN mkdir -p /workspace/jobs

EXPOSE 3000
CMD ["node", "src/index.js"]
