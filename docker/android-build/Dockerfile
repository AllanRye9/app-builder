FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$JAVA_HOME/bin

# --- Base dependencies -------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    unzip \
    ca-certificates \
    git \
    openjdk-17-jdk-headless \
    gradle \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js 20 (Ubuntu 22.04's default apt Node is too old for modern React tooling) --
RUN wget -qO- https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

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
RUN npm install -g @capacitor/cli@latest

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
