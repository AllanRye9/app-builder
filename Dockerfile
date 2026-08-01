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
# frontend and the /api/* routes. It ALSO shells out to the Docker CLI
# (server/dockerBuild.js) to run each upload's Android build in its own
# short-lived container from the apk-builder-android image (see
# docker/android-build/) — so, unlike the previous GitHub Actions edition,
# this image needs the `docker` CLI installed, and the running container
# needs a way to reach a Docker daemon.
#
# The simplest, most robust way to satisfy that: run this server directly
# on the same host as the Docker daemon (a bare VPS/local machine — build
# and run this image there, or just `npm start` without Docker at all) so
# `docker run ...` from inside this container talks to the daemon over a
# bind-mounted socket with matching filesystem paths. If you instead run
# THIS server itself in a container (Docker-out-of-Docker), you must:
#   1. bind-mount the host's Docker socket in:
#      -v /var/run/docker.sock:/var/run/docker.sock
#   2. bind-mount a real host directory in at a known path and set that
#      same path as "workspaceRoot" in config.json, with "hostWorkspaceRoot"
#      set to the directory's path ON THE HOST — see config.example.json.
#      Without this, `docker run -v <path> ...` issued from inside this
#      container will reference a path the HOST's Docker daemon can't see.
# See the README's "Running the build locally with Docker" section.
FROM node:20-alpine AS app
WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY --from=build /app/dist ./dist

# No ENV instructions here on purpose — every setting this app needs
# comes from config.json instead of environment variables — see
# config.example.json. This image intentionally does NOT COPY a
# config.json in; supply one at container run time if you need to override
# a default:
#   docker run -v $(pwd)/config.json:/app/config.json \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -p 3000:3000 <image>
# Set "port" in config.json if you need something other than the default
# 3000 (and update the EXPOSE/-p mapping to match).

EXPOSE 3000
CMD ["node", "server/index.js"]
