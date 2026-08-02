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

RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true && \
    sdkmanager --install "platform-tools" "platforms;android-34" "build-tools;34.0.0" > /dev/null

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
EXPOSE 8000
CMD ["/opt/venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
