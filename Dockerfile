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
# Render (like Vercel) doesn't expose a host Docker socket to a service, so
# the "spawn a sibling docker container per build" approach this project
# used on a VPS can't work here. The fix isn't a workaround — it's that the
# build toolchain (JDK, Android SDK, Gradle) simply lives in this same
# image, and src/buildRunner.js runs builds as direct subprocesses instead
# of `docker run`. One container, one process, no socket needed.
FROM node:22-bookworm-slim AS app

# Must be Debian/glibc-based, not Alpine — the Android SDK's prebuilt
# binaries (aapt2, the Gradle-bundled JVM launcher, etc.) require glibc and
# don't run correctly against musl.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jdk-headless \
    unzip \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
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
# Render's filesystem is ephemeral per-instance, which is exactly what job
# workspaces want — they're meant to be temporary and get cleaned up by
# jobStore.js's own TTL sweep regardless.
ENV JOB_ROOT=/tmp/apk-builder-jobs
RUN mkdir -p /tmp/apk-builder-jobs

# Render sets $PORT itself at runtime; this EXPOSE is documentation, not
# what actually controls the listening port (src/config.js reads
# process.env.PORT).
EXPOSE 3000
CMD ["node", "src/index.js"]
