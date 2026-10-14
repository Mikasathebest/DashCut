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

base=$(git describe --tags --abbrev=0 2>/dev/null || echo "v$(node -p 'require("./package.json").version')")
version="${base#v}-dev.$(date +%Y%m%d%H%M)"

npm run media:verify
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64 --publish never \
  -c.mac.notarize=false -c.extraMetadata.version="$version"

osascript -e 'tell application "DashCut" to quit' 2>/dev/null || true
while pgrep -xq DashCut; do sleep 0.5; done
rm -rf "$app"
ditto release/mac-arm64/DashCut.app "$app"
echo "Installed DashCut $version to $app (installer: release/DashCut-$version-mac-arm64.dmg)"
