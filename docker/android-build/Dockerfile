# syntax=docker/dockerfile:1
#
# The ephemeral Android build environment. This is the image
# server/dockerBuild.js runs (via `docker run --rm ...`) once per upload —
# it replaces the GitHub-hosted Ubuntu runner from the previous GitHub
# Actions edition of this app. Every container started from this image:
#   1. reads the uploaded project zip from /workspace/upload (mounted
#      read-only by the server),
#   2. runs the same steps that previously lived in
#      .github/workflows/build-apk.yml (npm install, npm run build,
#      `cap add`/`cap sync` android, gradlew assembleDebug),
#   3. writes the resulting app-debug.apk to /workspace/output (mounted
#      writable by the server, which serves it back for download and
#      deletes it a few minutes later).
#
# Build this once (or whenever you change it) with:
#   docker build -t apk-builder-android docker/android-build
#
# IMPORTANT — this Dockerfile has NOT been build-tested in an automated way
# as part of generating this project: it downloads several hundred MB from
# Google's/NodeSource's servers (Android cmdline-tools, SDK packages, Node)
# which requires real internet access at build time. Run the build command
# above yourself and watch for errors the first time you use it — see the
# README's "Running the build locally with Docker" section for
# troubleshooting notes.

FROM eclipse-temurin:21-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    NODE_MAJOR=22

# --- OS packages + Node.js -------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        git \
        ca-certificates \
        gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Android SDK command-line tools -----------------------------------------
# Version pinned to a known-good cmdline-tools release; bump the URL below
# (from https://developer.android.com/studio#command-line-tools-only) if it
# ever stops being served.
ARG ANDROID_CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
ARG ANDROID_PLATFORM=android-34
ARG ANDROID_BUILD_TOOLS=34.0.0

RUN mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools" \
    && curl -fsSL "$ANDROID_CMDLINE_TOOLS_URL" -o /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d "$ANDROID_SDK_ROOT/cmdline-tools" \
    && mv "$ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools" "$ANDROID_SDK_ROOT/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip

ENV PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install \
        "platform-tools" \
        "platforms;${ANDROID_PLATFORM}" \
        "build-tools;${ANDROID_BUILD_TOOLS}" \
        > /dev/null

# --- Build script ------------------------------------------------------
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Defaults matching the previous GitHub Actions workflow's hardcoded
# app id/name (see README "Known trade-offs") — override at `docker run`
# time with -e APP_ID=... -e APP_NAME=... if needed.
ENV APP_ID=com.builder.app \
    APP_NAME=MyApp

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
