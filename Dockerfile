# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React dashboard
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: the app server AND the Android build toolchain, in one image
# ---------------------------------------------------------------------------
# Most modern hosting platforms (Render, Railway, Fly.io, Google Cloud Run,
# AWS App Runner, a plain VPS) run a container from a Dockerfile like this
# one directly — but none of them give a container access to a *host*
# Docker socket, so a "spawn a sibling docker container per build" approach
# can't work on any of them. The fix isn't a per-platform workaround — the
# build toolchain (JDK, Android SDK, Gradle) simply lives in this same
# image, and src/buildRunner.js runs builds as direct subprocesses instead
# of `docker run`. One container, one process, no socket needed, no
# platform-specific assumptions anywhere in this Dockerfile or in src/.
# JDK 21 comes from Temurin's own image rather than apt — Debian bookworm's
# default repos genuinely don't carry openjdk-21-jdk-headless (bookworm
# ships JDK 17; 21 isn't in the base "main" component), so relying on apt
# for this specific version is a real dead end, not just a flaky mirror.
# Copying the prebuilt JDK directly sidesteps distro package availability
# entirely.
FROM eclipse-temurin:21-jdk-jammy AS jdk

FROM node:22-bookworm-slim AS app

# Must be Debian/glibc-based, not Alpine — the Android SDK's prebuilt
# binaries (aapt2, the Gradle-bundled JVM launcher, etc.) require glibc and
# don't run correctly against musl.
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/opt/java/openjdk
COPY --from=jdk /opt/java/openjdk $JAVA_HOME
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools

# Pinned to a specific commandline-tools build rather than a "latest" alias
# that could change under us. If this download step ever 404s (Google does
# occasionally retire old build numbers), get the current filename from
# https://developer.android.com/studio#command-line-tools-only and pass
# --build-arg CMDLINE_TOOLS_VERSION=<new number> — this is the one place in
# the whole setup with an external version dependency, kept isolated here
# on purpose so it's a one-line fix if it ever goes stale.
ARG CMDLINE_TOOLS_VERSION=11076708
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && \
    curl -fsSL -o /tmp/cmdline-tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" && \
    unzip -q /tmp/cmdline-tools.zip -d $ANDROID_SDK_ROOT/cmdline-tools && \
    mv $ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

# Accept licenses non-interactively, then install exactly what a Capacitor
# 7.x Android build needs. Capacitor's own Gradle config pulls in whatever
# specific build-tools/platform revision it needs beyond this via Gradle
# itself — these are just the SDK-manager-level prerequisites.
RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true && \
    sdkmanager --install "platform-tools" "platforms;android-34" "build-tools;34.0.0" > /dev/null

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY --from=web-build /web/dist ./web/dist

ENV NODE_ENV=production
# Most container platforms give you an ephemeral filesystem per instance
# (reset on every deploy/restart) — which is exactly what job workspaces
# want, since they're meant to be temporary. jobStore.js's own TTL sweep and
# post-download cleanup already handle removing them during normal
# operation, so this isn't a gap to work around on any given platform.
ENV JOB_ROOT=/tmp/apk-builder-jobs
RUN mkdir -p /tmp/apk-builder-jobs

# Most platforms (Render, Railway, Cloud Run, App Runner, etc.) inject a
# PORT env var and expect the app to listen on it; this EXPOSE is
# documentation for anyone running the image directly, not what actually
# controls the listening port (src/config.js reads process.env.PORT, and
# falls back to 3000 for plain `docker run`/local use).
EXPOSE 3000
CMD ["node", "src/index.js"]
