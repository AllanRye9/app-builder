#!/usr/bin/env bash
# Runs once per build container (server/dockerBuild.js starts a fresh
# container from this image for every job — nothing here persists between
# uploads). Mirrors the steps the README describes the previous GitHub
# Actions workflow as running: npm install → npm run build → cap
# add/sync android → gradlew assembleDebug.
#
# server/dockerBuild.js watches stdout for lines starting with "PHASE:" to
# report coarse progress back to the dashboard — keep those markers if you
# edit this script, or update dockerBuild.js's onPhase handling to match.
set -uo pipefail

UPLOAD_ZIP="/workspace/upload/${ZIP_FILENAME:?ZIP_FILENAME env var is required}"
PROJECT_DIR="/workspace/project"
OUTPUT_DIR="/workspace/output"
APP_ID="${APP_ID:-com.builder.app}"
APP_NAME="${APP_NAME:-MyApp}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ -f "$UPLOAD_ZIP" ]] || fail "Uploaded zip not found at $UPLOAD_ZIP"

echo "PHASE:extracting"
mkdir -p "$PROJECT_DIR"
unzip -q "$UPLOAD_ZIP" -d "$PROJECT_DIR" || fail "Could not extract $UPLOAD_ZIP — is it a valid zip file?"

# If the zip contains exactly one top-level directory (e.g. zipping a
# project folder rather than its contents), descend into it so
# package.json etc. end up where the rest of this script expects them.
shopt -s nullglob dotglob
entries=("$PROJECT_DIR"/*)
shopt -u nullglob dotglob
if [[ ${#entries[@]} -eq 1 && -d "${entries[0]}" ]]; then
  PROJECT_DIR="${entries[0]}"
fi

cd "$PROJECT_DIR" || fail "Could not enter $PROJECT_DIR"
[[ -f package.json ]] || fail "No package.json found in the uploaded project."

echo "PHASE:installing"
if [[ -f package-lock.json ]]; then
  npm ci || fail "npm ci failed."
else
  npm install || fail "npm install failed."
fi

echo "PHASE:building_web"
if ! npm run build --if-present; then
  fail "npm run build failed."
fi

WEB_DIR=""
for candidate in dist build www out; do
  if [[ -d "$candidate" ]]; then
    WEB_DIR="$candidate"
    break
  fi
done
[[ -n "$WEB_DIR" ]] || fail "Could not find a web build output directory (looked for dist, build, www, out)."

echo "PHASE:building_android"
if [[ ! -f capacitor.config.json && ! -f capacitor.config.ts ]]; then
  npx --yes @capacitor/cli init "$APP_NAME" "$APP_ID" --web-dir="$WEB_DIR" \
    || fail "cap init failed."
fi

if [[ -d android ]]; then
  npx --yes @capacitor/cli sync android || fail "cap sync android failed."
else
  npx --yes @capacitor/cli add android || fail "cap add android failed."
fi

cd android || fail "Android platform directory is missing after cap add/sync."
chmod +x ./gradlew
./gradlew assembleDebug --no-daemon --console=plain || fail "gradlew assembleDebug failed."

APK_PATH=$(find app/build/outputs/apk/debug -maxdepth 1 -name '*.apk' | head -n1)
[[ -n "$APK_PATH" ]] || fail "Build finished but no .apk was produced under app/build/outputs/apk/debug."

mkdir -p "$OUTPUT_DIR"
cp "$APK_PATH" "$OUTPUT_DIR/app-debug.apk" || fail "Could not copy the built APK to $OUTPUT_DIR."

echo "PHASE:done"
