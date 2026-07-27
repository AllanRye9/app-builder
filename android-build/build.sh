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
    curl \
    gnupg \
    openjdk-17-jdk-headless \
    openjdk-21-jdk-headless \
    gradle \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js 22 (bootstrap baseline) -------------------------------------
# Need to run apt-get update in the same RUN layer as the NodeSource setup
# to ensure the newly added repository is available for package installation
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v

# `n` lets build.sh swap the running Node version at container runtime.
RUN npm install -g n

# --- Android SDK command-line tools ------------------------------------
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d $ANDROID_SDK_ROOT/cmdline-tools \
    && mv $ANDROID_SDK_ROOT/cmdline-tools/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip

# --- Pre-accept licenses & pre-install SDK packages ---
RUN yes | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
    && $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager \
        "platform-tools" \
        "platforms;android-35" \
        "build-tools;34.0.0" > /dev/null

# --- Capacitor CLI, available globally inside the image -----------------
RUN npm install -g @capacitor/cli@latest

# --- Expected mount points ------------------------------------------------
RUN mkdir -p /project /output

WORKDIR /build
COPY build.sh /build/build.sh
RUN chmod +x /build/build.sh

ENTRYPOINT ["/build/build.sh"]