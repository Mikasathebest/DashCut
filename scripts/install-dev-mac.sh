#!/usr/bin/env bash
# Build an unsigned Apple Silicon DMG from this checkout and replace /Applications/DashCut.app.
# The FFmpeg and faster-whisper runtimes are slow to build, so they are reused from
# media-runtime/current and local-runtime/ when present, or seeded once from the installed app.
set -euo pipefail
cd "$(dirname "$0")/.."

app=/Applications/DashCut.app
installed="$app/Contents/Resources"

seed_runtime() {
  local target=$1 source=$2 hint=$3
  [[ -e "$target" ]] && return
  if [[ ! -e "$source" ]]; then
    echo "Missing $target and no installed DashCut to copy it from; run $hint first." >&2
    exit 1
  fi
  echo "Seeding $target from $source"
  mkdir -p "$(dirname "$target")"
  ditto "$source" "$target"
}

seed_runtime media-runtime/current "$installed/media-runtime" "npm run media:build"
seed_runtime local-runtime/dashcut-transcribe "$installed/local-runtime/dashcut-transcribe" "npm run runtime:build"

# DASHCUT_INSTALL_ONLY=1 reuses the last build in release/mac-arm64 (e.g. after quitting DashCut).
if [[ "${DASHCUT_INSTALL_ONLY:-}" == "1" && -d release/mac-arm64/DashCut.app ]]; then
  version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" release/mac-arm64/DashCut.app/Contents/Info.plist)
  skip_build=1
fi

base=$(git describe --tags --abbrev=0 2>/dev/null || echo "v$(node -p 'require("./package.json").version')")
version="${version:-${base#v}-dev.$(date +%Y%m%d%H%M)}"

if [[ -z "${skip_build:-}" ]]; then
  npm run media:verify
  npm run build
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  npx electron-builder --mac dir --arm64 --publish never -c.mac.notarize=false -c.extraMetadata.version="$version"
fi

# A running DashCut with unsaved work shows a save prompt instead of quitting; never wait on it forever.
osascript -e 'tell application "DashCut" to quit' 2>/dev/null || true
for _ in $(seq 1 60); do pgrep -xq DashCut || break; sleep 0.5; done
if pgrep -xq DashCut; then
  echo "DashCut is still open (probably asking to save changes). Save or close it, then run:" >&2
  echo "  DASHCUT_INSTALL_ONLY=1 npm run install:dev-mac" >&2
  exit 2
fi
rm -rf "$app"
ditto release/mac-arm64/DashCut.app "$app"
echo "Installed DashCut $version to $app"

# The installer is a convenience; a flaky disk-image unmount must not undo the install above.
if [[ "${DASHCUT_SKIP_DMG:-}" != "1" ]]; then
  npx electron-builder --mac dmg --arm64 --publish never --prepackaged release/mac-arm64/DashCut.app \
    -c.mac.notarize=false -c.extraMetadata.version="$version" \
    && echo "Installer: release/DashCut-$version-mac-arm64.dmg" \
    || echo "warning: DMG build failed; the app is installed, rerun later for an installer" >&2
fi

# Leave only /Applications/DashCut.app; the build copy would otherwise show up in Spotlight and Launchpad.
rm -rf release/mac-arm64
