#!/bin/bash
set -euo pipefail

PROJECT_DIR=/project   # bind-mounted from the caller (host or apk-builder server)
OUTPUT_DIR=/output     # bind-mounted from the caller (where the APK lands)
APP_ID="${APP_ID:-com.builder.app}"
APP_NAME="${APP_NAME:-MyApp}"

echo "=== apk-builder: starting build ==="
echo "Node: $(node -v) | npm: $(npm -v)"

# --- Fail fast with a clear message instead of a bare "cd: No such file" ---
# This is almost always caused by running the image without the required
# bind mounts, e.g.:
#
#     docker run --rm apk-builder-android          # <- missing -v flags
#
# instead of:
#
#     docker run --rm \
#       -v "$(pwd)/my-react-app:/project" \
#       -v "$(pwd)/output:/output" \
#       apk-builder-android
#
# If this container was launched by the apk-builder web server, this
# usually means JOB_ROOT / HOST_JOB_ROOT don't agree — see src/config.js.
if [ ! -d "$PROJECT_DIR" ]; then
  echo "ERROR: $PROJECT_DIR does not exist inside this container." >&2
  echo "This image expects your project to be bind-mounted at $PROJECT_DIR." >&2
  echo 'Run it as: docker run --rm -v "$(pwd)/my-app:/project" -v "$(pwd)/output:/output" apk-builder-android' >&2
  exit 1
fi

if [ -z "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; then
  echo "ERROR: $PROJECT_DIR was mounted but is empty." >&2
  echo "Check that the host path you bind-mounted actually contains your React project (with package.json at its root)." >&2
  exit 1
fi

if [ ! -d "$OUTPUT_DIR" ]; then
  echo "ERROR: $OUTPUT_DIR does not exist inside this container. Mount an output directory with -v \"\$(pwd)/output:/output\"." >&2
  exit 1
fi

cd "$PROJECT_DIR"

echo "--- Installing dependencies ---"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "--- Running web build ---"
if ! npm run | grep -qE '^\s*build\b'; then
  echo "ERROR: project's package.json has no \"build\" script." >&2
  exit 1
fi
npm run build

# Figure out which directory the web build produced.
WEB_DIR=""
for candidate in dist build out; do
  if [ -d "$PROJECT_DIR/$candidate" ]; then
    WEB_DIR="$candidate"
    break
  fi
done
if [ -z "$WEB_DIR" ]; then
  echo "ERROR: could not find a web build output directory (looked for dist/, build/, out/)." >&2
  exit 1
fi
echo "Detected web build output: $WEB_DIR"

echo "--- Initializing Capacitor ---"
if [ ! -f capacitor.config.json ] && [ ! -f capacitor.config.ts ]; then
  npx --yes cap init "$APP_NAME" "$APP_ID" --web-dir "$WEB_DIR"
fi

echo "--- Installing Capacitor Android platform package ---"
# Newer Capacitor CLI versions (unlike older ones) no longer auto-install the
# platform package during `cap add android` — it must already be a project
# dependency, or the CLI fails with:
#   [error] Could not find the android platform.
#   You must install it in your project first, e.g. w/ npm install @capacitor/android
# Pin to the same major version as the globally installed CLI (see the
# Dockerfile) so core/android/cli versions can't drift apart.
CAPACITOR_MAJOR="${CAPACITOR_MAJOR:-7}"
npm install --no-save "@capacitor/core@$CAPACITOR_MAJOR" "@capacitor/android@$CAPACITOR_MAJOR"

echo "--- Adding Android platform ---"
rm -rf android
npx --yes cap add android
npx --yes cap copy android

MANIFEST="android/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ] && ! grep -q "android.permission.INTERNET" "$MANIFEST"; then
  echo "--- Patching AndroidManifest.xml with base permissions ---"
  sed -i '/<manifest/a\
    <uses-permission android:name="android.permission.INTERNET" />\
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />' "$MANIFEST"
fi

echo "sdk.dir=$ANDROID_SDK_ROOT" > android/local.properties

echo "--- Building APK with Gradle ---"
cd android
chmod +x ./gradlew
./gradlew clean assembleDebug --no-daemon

APK_SRC="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK_SRC" ]; then
  echo "ERROR: Gradle finished but no APK was produced at $APK_SRC." >&2
  exit 1
fi

cp "$APK_SRC" "$OUTPUT_DIR/app.apk"
chmod 644 "$OUTPUT_DIR/app.apk"
echo "=== apk-builder: build succeeded, APK copied to /output/app.apk ==="
