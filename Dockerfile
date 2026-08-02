# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React dashboard (unchanged from the Node version)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: the FastAPI server AND the Android build toolchain, in one image
# ---------------------------------------------------------------------------
# Same rationale as before: one container, one process, no Docker socket, no
# platform-specific glue. The server itself is now Python/FastAPI
# (app/build_runner.py), but it still shells out to `npm`/`npx`/`gradlew` as
# direct subprocesses to build uploaded projects — so Node stays in this
# image alongside Python.
FROM eclipse-temurin:21-jdk-jammy AS jdk

FROM node:22-bookworm-slim AS app

# Must be Debian/glibc-based, not Alpine — the Android SDK's prebuilt
# binaries require glibc and don't run correctly against musl.
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    curl \
    ca-certificates \
    git \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/opt/java/openjdk
COPY --from=jdk /opt/java/openjdk $JAVA_HOME
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:/opt/venv/bin

# Pinned to a specific commandline-tools build rather than a "latest" alias
# that could change under us. If this ever 404s, get the current filename
# from https://developer.android.com/studio#command-line-tools-only and
# pass --build-arg CMDLINE_TOOLS_VERSION=<new number>.
ARG CMDLINE_TOOLS_VERSION=11076708
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && \
    curl -fsSL -o /tmp/cmdline-tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" && \
    unzip -q /tmp/cmdline-tools.zip -d $ANDROID_SDK_ROOT/cmdline-tools && \
    mv $ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

# Capacitor's default major version pinned in app/config.py (CAPACITOR_MAJOR,
# currently "7") requires compileSdkVersion/targetSdkVersion 35 — see
# https://capacitorjs.com/docs/updating/7-0. Only having android-34 +
# build-tools 34.0.0 here (as an earlier revision of this image did) meant
# every default Capacitor build had to auto-download SDK Platform 35 and
# build-tools 35.0.0 from Google's servers on its *first* build in a fresh
# container — adding several extra minutes on top of the Gradle
# distribution/dependency downloads that first build already has to do, and
# an easy way to blow past BUILD_TIMEOUT_MS (15 min default) or hang if that
# on-demand download stalls. Pre-installing both here means every build,
# from the very first one in a fresh container, only ever needs what's
# already on disk. android-34/build-tools 34.0.0 are kept alongside so
# native-Android uploads pinned to the older SDK still build unmodified.
#
# `set -e` (not `|| true`) so a real sdkmanager failure fails the image
# build here, loudly, instead of silently shipping an image that will only
# discover the problem — as a build that never completes — once real
# traffic hits it.
RUN set -e && \
    yes | sdkmanager --licenses > /dev/null && \
    sdkmanager --install \
      "platform-tools" \
      "platforms;android-34" "build-tools;34.0.0" \
      "platforms;android-35" "build-tools;35.0.0" \
      > /dev/null && \
    yes | sdkmanager --licenses > /dev/null

# Isolated virtualenv for the Python server, kept off the system Python so
# it can never collide with anything apt/sdkmanager might also touch.
RUN python3 -m venv /opt/venv
WORKDIR /app
COPY requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY --from=web-build /web/dist ./web/dist

ENV JOB_ROOT=/tmp/apk-builder-jobs
RUN mkdir -p /tmp/apk-builder-jobs

# Most platforms (Render, Railway, Cloud Run, App Runner, etc.) inject a
# PORT env var and expect the app to listen on it; this EXPOSE is
# documentation for anyone running the image directly — app/config.py
# reads $PORT itself and falls back to 8000 for plain `docker run`/local use.
#
# CMD must actually honor that same $PORT (shell form, so ${PORT:-8000} gets
# expanded) rather than hardcoding --port 8000 — otherwise the app binds to
# 8000 while the platform's health check probes whatever port it actually
# assigned, and the deployment never leaves "starting"/"unhealthy" no matter
# how many times the build itself succeeds.
EXPOSE 8000
CMD ["/bin/sh", "-c", "exec /opt/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
