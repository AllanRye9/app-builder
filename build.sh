#!/bin/bash
set -euo pipefail

PROJECT_DIR=/project   # mounted from host (extracted upload)
OUTPUT_DIR=/output     # mounted from host (where the APK lands)
APP_ID="${APP_ID:-com.builder.app}"
APP_NAME="${APP_NAME:-MyApp}"

echo "=== apk-builder: starting build ==="
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
