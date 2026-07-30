FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$JAVA_HOME/bin

# --- Base dependencies -------------------------------------------------
# JDK 21 only. capacitor-android's build.gradle has hardcoded
# `sourceCompatibility JavaVersion.VERSION_21` since Capacitor 7.0.1 (see
# ionic-team/capacitor#7879) and still does as of the 8.x line — it is not a
# recent or temporary requirement, so there is no "latest-compatible"
# version to chase here. A dual-JDK-with-runtime-detection setup was tried
# here previously and added a failure mode of its own (silent detection
# misses); a single pinned JDK that's known to satisfy every currently
# supported Capacitor major is simpler and cannot drift out of sync with
# itself. If a future Capacitor major ever requires a newer JDK, bump this
# one line deliberately — the RUN check below will catch it loudly at
# `docker build` time rather than failing at the bottom of a 5-minute Gradle
# run.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    unzip \
    ca-certificates \
    git \
    openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Fail the image build itself, immediately and unambiguously, if JDK 21
# didn't actually install — instead of that only surfacing later as a
# confusing "invalid source release: 21" from Gradle at build time.
RUN java -version 2>&1 | grep -q '"21' \
    || (echo "FATAL: expected JDK 21 after install, got: $(java -version 2>&1 | head -1)" && exit 1)

# Bumped whenever this file changes in a way that matters (JDK version,
# Capacitor pin, Node pin). `docker images` and `docker inspect
# apk-builder-android:latest` both show this — if what you see there
# doesn't match this file, the image is stale and needs a rebuild; see
# build.sh's startup check for the same signal from inside a running build.
LABEL apk-builder.image-version="jdk21-single-2026-07-28"
ENV APK_BUILDER_IMAGE_VERSION="jdk21-single-2026-07-28"

# --- Node.js 22 (Ubuntu 22.04's default apt Node is too old for modern React
# tooling, and the Capacitor CLI itself now requires Node >=22 — an older
# pin here is what causes "[fatal] The Capacitor CLI requires NodeJS >=22.0.0") --
RUN wget -qO- https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v

# --- Android SDK command-line tools ------------------------------------
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d $ANDROID_SDK_ROOT/cmdline-tools \
    && mv $ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip

# --- Pre-accept licenses & pre-install SDK packages so builds never hit ---
# --- an interactive prompt and don't re-download the SDK every run -------
RUN yes | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
    && $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager \
        "platform-tools" \
        "platforms;android-35" \
        "build-tools;34.0.0" > /dev/null

# --- Capacitor CLI, available globally inside the image -----------------
# Pinned (rather than @latest) so a future Capacitor release with a higher
# Node requirement doesn't silently break this image again — bump
# deliberately, alongside the Node version above, when you want to upgrade.
RUN npm install -g @capacitor/cli@7

# --- Expected mount points ------------------------------------------------
# /project and /output are bind-mounted in by the caller (either a person
# running `docker run` directly, or the apk-builder server via docker-runner.js).
# Creating them here means a mis-mounted run fails with a clear message from
# build.sh instead of a bare "No such file or directory" from `cd`.
RUN mkdir -p /project /output

WORKDIR /build
COPY build.sh /build/build.sh
RUN chmod +x /build/build.sh

ENTRYPOINT ["/build/build.sh"]
