#!/bin/bash
set -euo pipefail

PROJECT_DIR=/project   # bind-mounted from the caller (host or apk-builder server)
OUTPUT_DIR=/output     # bind-mounted from the caller (where the APK lands)
APP_ID="${APP_ID:-com.builder.app}"
APP_NAME="${APP_NAME:-MyApp}"

# ---------------------------------------------------------------------------
# notice(): emit a structured, UI-visible event — distinct from a plain log
# line. The apk-builder server watches for this exact "##NOTICE## <json>"
# marker on stdout (see src/dockerRunner.js) and forwards it to the browser
# as a dedicated SSE "notice" event, which the React app renders as a
# dismissible pop-up instead of leaving it buried in scrolling log text.
# Use this for anything the script decided or fixed dynamically — a version
# it matched, a package it installed on the fly, a permission it patched in —
# so the person watching the build actually sees it happen.
# ---------------------------------------------------------------------------
notice() {
  local level="$1" title="$2" message="$3"
  node -e '
    const [level, title, message] = process.argv.slice(1);
    console.log("##NOTICE## " + JSON.stringify({ level, title, message }));
  ' "$level" "$title" "$message"
}

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

# ---------------------------------------------------------------------------
# ensure_capacitor_compatible_node(): self-healing Node version check.
# Reads whatever @capacitor/cli actually declares as its own minimum Node
# version (its package.json "engines.node" field) and, if the Node baked
# into this image is no longer sufficient, upgrades it on the fly with `n`
# — no image rebuild required. This is what would have absorbed the
# "[fatal] The Capacitor CLI requires NodeJS >=22.0.0" failure automatically
# instead of needing a manual Dockerfile edit.
# ---------------------------------------------------------------------------
ensure_capacitor_compatible_node() {
  local global_modules cli_pkg required required_major current_major
  global_modules="$(npm root -g)"
  cli_pkg="$global_modules/@capacitor/cli/package.json"

  if [ ! -f "$cli_pkg" ]; then
    return 0
  fi

  required="$(node -p "(require('$cli_pkg').engines || {}).node || ''" 2>/dev/null || true)"
  if [ -z "$required" ]; then
    return 0
  fi

  required_major="$(echo "$required" | grep -oE '[0-9]+' | head -n1 || true)"
  current_major="$(node -p "process.versions.node.split('.')[0]")"

  if [ -n "$required_major" ] && [ "$current_major" -lt "$required_major" ]; then
    notice "warning" "Upgrading Node.js at runtime" \
      "Capacitor CLI $(node -p "require('$cli_pkg').version") requires Node >=$required_major, but this container has Node $current_major. Installing Node $required_major automatically (no image rebuild needed) and continuing."
    n "$required_major" > /dev/null 2>&1
    hash -r
    notice "info" "Node upgraded" "Now running Node $(node -v)."
  fi
}

ensure_capacitor_compatible_node

# ---------------------------------------------------------------------------
# run_cap_step(): run a Capacitor CLI step; if it fails and its own output
# suggests a fix in the form "npm install <package(s)>" — which is exactly
# how these CLI errors are worded (e.g. "You must install it in your project
# first, e.g. w/ npm install @capacitor/android") — install what it asked
# for and retry once automatically, surfacing a notice either way. This
# generalizes past the one specific missing-package error we've already hit,
# to any similar CLI complaint in the future.
# ---------------------------------------------------------------------------
run_cap_step() {
  local step_name="$1"; shift
  local log_file
  log_file="$(mktemp)"

  # Captured to a file rather than streamed via `tee` + process substitution:
  # process substitution has a documented bash race where the parent script
  # isn't guaranteed the reader has finished writing before it moves on —
  # not worth risking for the sake of live output on these quick, one-shot
  # CLI steps. Printed as a block immediately after, so nothing is lost.
  if "$@" > "$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    return 0
  fi
  cat "$log_file"

  local suggestion
  suggestion="$(grep -oP 'npm install \K.+' "$log_file" | tail -n1 || true)"
  rm -f "$log_file"

  if [ -n "$suggestion" ]; then
    notice "warning" "Installing a missing dependency" \
      "\"$step_name\" reported a missing package and suggested: npm install $suggestion. Installing it automatically and retrying."
    # shellcheck disable=SC2086
    npm install --no-save $suggestion
    if "$@"; then
      return 0
    fi
  fi

  notice "error" "\"$step_name\" failed" "See the build log above for details."
  return 1
}

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
notice "info" "Detected web build output" "Using '$WEB_DIR/' as the web asset directory for the Android shell."

echo "--- Initializing Capacitor ---"
if [ ! -f capacitor.config.json ] && [ ! -f capacitor.config.ts ]; then
  run_cap_step "cap init" npx --yes cap init "$APP_NAME" "$APP_ID" --web-dir "$WEB_DIR"
fi

echo "--- Matching Capacitor platform packages to installed CLI ---"
# Rather than assuming a major version number, read whatever CLI version is
# actually globally installed (see the Dockerfile) and install matching
# @capacitor/core / @capacitor/android — so this can never drift out of sync
# with the CLI, regardless of which version ends up in the image.
CLI_PKG="$(npm root -g)/@capacitor/cli/package.json"
CLI_VERSION="$(node -p "require('$CLI_PKG').version" 2>/dev/null || echo unknown)"
CAPACITOR_MAJOR="${CAPACITOR_MAJOR:-${CLI_VERSION%%.*}}"

if [ "$CAPACITOR_MAJOR" = "unknown" ] || [ -z "$CAPACITOR_MAJOR" ]; then
  notice "warning" "Could not detect Capacitor CLI version" "Falling back to @capacitor/core@latest and @capacitor/android@latest."
  npm install --no-save "@capacitor/core@latest" "@capacitor/android@latest"
else
  notice "info" "Matching Capacitor platform version" \
    "Capacitor CLI $CLI_VERSION detected — installing @capacitor/core@$CAPACITOR_MAJOR and @capacitor/android@$CAPACITOR_MAJOR to match."
  npm install --no-save "@capacitor/core@$CAPACITOR_MAJOR" "@capacitor/android@$CAPACITOR_MAJOR"
fi

echo "--- Adding Android platform ---"
rm -rf android
run_cap_step "cap add android" npx --yes cap add android
run_cap_step "cap copy android" npx --yes cap copy android

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
  notice "info" "Added base Android permissions" "Patched AndroidManifest.xml with INTERNET, network state, location, and storage permissions."
fi

echo "sdk.dir=$ANDROID_SDK_ROOT" > android/local.properties

echo "--- Building APK with Gradle ---"
cd android
chmod +x ./gradlew
./gradlew clean assembleDebug --no-daemon

APK_SRC="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK_SRC" ]; then
  echo "ERROR: Gradle finished but no APK was produced at $APK_SRC." >&2
  notice "error" "Build failed" "Gradle finished but no APK was produced. See the log above for details."
  exit 1
fi

cp "$APK_SRC" "$OUTPUT_DIR/app.apk"
chmod 644 "$OUTPUT_DIR/app.apk"
echo "=== apk-builder: build succeeded, APK copied to /output/app.apk ==="
notice "success" "Build succeeded" "app.apk is ready to download."
