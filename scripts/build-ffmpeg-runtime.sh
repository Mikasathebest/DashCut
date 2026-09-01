#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
# shellcheck source=ffmpeg-runtime.env
source "$script_dir/ffmpeg-runtime.env"

runtime_dir="$project_dir/media-runtime/current"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/dashcut-ffmpeg.XXXXXX")"
archive="$work_dir/ffmpeg-$FFMPEG_VERSION.tar.xz"
source_dir="$work_dir/ffmpeg-$FFMPEG_VERSION"
install_dir="$work_dir/install"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

verify_sha256() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$FFMPEG_SHA256" "$target" | sha256sum -c -
  else
    local actual
    actual="$(shasum -a 256 "$target" | awk '{print $1}')"
    if [[ "$actual" != "$FFMPEG_SHA256" ]]; then
      echo "FFmpeg source checksum mismatch: $actual" >&2
      exit 1
    fi
  fi
}

copy_macos_dependencies() {
  local brew_root binary dependency source target base index
  brew_root="$(brew --prefix)"
  local -a queue
  queue=("$runtime_dir/ffmpeg")
  index=0
  while [[ $index -lt ${#queue[@]} ]]; do
    binary="${queue[$index]}"
    index=$((index + 1))
    while IFS= read -r dependency; do
      case "$dependency" in
        /System/*|/Library/Apple/System/*|/usr/lib/*|@executable_path/*) continue ;;
      esac
      base="$(basename "$dependency")"
      target="$runtime_dir/$base"
      if [[ "$dependency" == @loader_path/* ]]; then
        source="$(cd "$(dirname "$binary")" && pwd)/${dependency#@loader_path/}"
      elif [[ "$dependency" == @rpath/* ]]; then
        source="$(find "$brew_root" -type f -name "$base" -print -quit)"
      else
        source="$dependency"
      fi
      if [[ -z "${source:-}" || ! -e "$source" ]]; then
        echo "Unable to resolve macOS library dependency $dependency from $binary" >&2
        exit 1
      fi
      if [[ ! -e "$target" ]]; then
        cp -L "$source" "$target"
        chmod 755 "$target"
        queue+=("$target")
      fi
      install_name_tool -change "$dependency" "@executable_path/$base" "$binary"
    done < <(otool -L "$binary" | tail -n +2 | awk '{print $1}')
    if [[ "$binary" == *.dylib ]]; then
      install_name_tool -id "@executable_path/$(basename "$binary")" "$binary"
    fi
  done
  for binary in "$runtime_dir"/ffmpeg "$runtime_dir"/*.dylib; do
    [[ -e "$binary" ]] || continue
    codesign --force --sign - "$binary"
  done
}

copy_windows_dependencies() {
  local binary dependency target index windows_dir missing
  windows_dir="$(cygpath -u "${WINDIR:-C:\\Windows}")"
  local -a queue
  queue=("$runtime_dir/ffmpeg.exe")
  index=0
  while [[ $index -lt ${#queue[@]} ]]; do
    binary="${queue[$index]}"
    index=$((index + 1))
    while IFS= read -r dependency; do
      [[ -n "$dependency" && -f "$dependency" ]] || continue
      case "$dependency" in
        "$windows_dir"/*|/c/Windows/*|/c/WINDOWS/*|/C/Windows/*|/C/WINDOWS/*|/Windows/*|/WINDOWS/*) continue ;;
      esac
      target="$runtime_dir/$(basename "$dependency")"
      if [[ ! -e "$target" ]]; then
        cp -L "$dependency" "$target"
        queue+=("$target")
      fi
    done < <(ldd "$binary" | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }')
    missing="$(ldd "$binary" | grep 'not found' | grep -Eiv 'api-ms-win|ext-ms-win' || true)"
    if [[ -n "$missing" ]]; then
      printf '%s\n' "$missing" >&2
      exit 1
    fi
  done
}

copy_macos_licenses() {
  local formula formula_root license target_dir
  mkdir -p "$runtime_dir/THIRD-PARTY-LICENSES"
  while IFS= read -r formula; do
    [[ -n "$formula" ]] || continue
    formula_root="$(brew --prefix "$formula")"
    target_dir="$runtime_dir/THIRD-PARTY-LICENSES/$formula"
    mkdir -p "$target_dir"
    while IFS= read -r license; do
      cp "$license" "$target_dir/$(basename "$license")"
    done < <(find "$formula_root" -maxdepth 4 -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) -print)
    printf 'Homebrew formula: https://formulae.brew.sh/formula/%s\n' "$formula" > "$target_dir/SOURCE.txt"
  done < <(printf '%s\n' libass; brew deps --recursive libass)
}

copy_windows_licenses() {
  local binary_path package license target_dir source_path
  local package_list="$work_dir/runtime-packages.txt"
  : > "$package_list"
  for binary_path in "$runtime_dir"/*.dll; do
    [[ -e "$binary_path" ]] || continue
    source_path="/mingw64/bin/$(basename "$binary_path")"
    [[ -e "$source_path" ]] || continue
    pacman -Qo "$source_path" 2>/dev/null | sed -n 's/.* is owned by \([^ ]*\) .*/\1/p' >> "$package_list"
  done
  mkdir -p "$runtime_dir/THIRD-PARTY-LICENSES"
  sort -u "$package_list" | while IFS= read -r package; do
    [[ -n "$package" ]] || continue
    target_dir="$runtime_dir/THIRD-PARTY-LICENSES/$package"
    mkdir -p "$target_dir"
    while IFS= read -r license; do
      [[ -f "/$license" ]] && cp "/$license" "$target_dir/$(basename "$license")"
    done < <(pacman -Ql "$package" | awk '{print $2}' | grep '/share/licenses/' || true)
    printf 'MSYS2 package: https://packages.msys2.org/package/%s\n' "$package" > "$target_dir/SOURCE.txt"
  done
}

if ! pkg-config --exists libass; then
  echo "libass development files are required. Install Homebrew libass on macOS or mingw-w64-x86_64-libass in MSYS2." >&2
  exit 1
fi

echo "Downloading FFmpeg $FFMPEG_VERSION from the official source archive"
curl --fail --location --retry 3 "$FFMPEG_SOURCE_URL" --output "$archive"
verify_sha256 "$archive"
tar -xf "$archive" -C "$work_dir"

common_config=(
  "--prefix=$install_dir"
  --disable-autodetect
  --disable-debug
  --disable-doc
  --disable-ffplay
  --disable-gpl
  --disable-nonfree
  --disable-libx264
  --disable-libx265
  --enable-static
  --disable-shared
  --enable-pthreads
  --enable-libass
)

case "$(uname -s)" in
  Darwin)
    platform="macOS"
    required_encoder="h264_videotoolbox"
    platform_config=(--enable-videotoolbox --disable-mediafoundation)
    jobs="$(sysctl -n hw.logicalcpu)"
    executable_name="ffmpeg"
    ;;
  MINGW*|MSYS*)
    platform="Windows"
    required_encoder="h264_mf"
    platform_config=(--target-os=mingw32 --arch=x86_64 --enable-mediafoundation --disable-videotoolbox)
    jobs="${NUMBER_OF_PROCESSORS:-4}"
    executable_name="ffmpeg.exe"
    ;;
  *)
    echo "Only native macOS and MSYS2/MinGW Windows builds are supported" >&2
    exit 1
    ;;
esac

cd "$source_dir"
./configure "${common_config[@]}" "${platform_config[@]}"
make -j"$jobs"
make install

case "$runtime_dir" in
  "$project_dir/media-runtime/current") rm -rf "$runtime_dir" ;;
  *) echo "Refusing to replace unexpected runtime path: $runtime_dir" >&2; exit 1 ;;
esac
mkdir -p "$runtime_dir"
cp "$install_dir/bin/$executable_name" "$runtime_dir/$executable_name"
chmod 755 "$runtime_dir/$executable_name"

if [[ "$platform" == "macOS" ]]; then
  copy_macos_dependencies
  copy_macos_licenses
else
  copy_windows_dependencies
  copy_windows_licenses
fi

ffmpeg_binary="$runtime_dir/$executable_name"
build_configuration="$($ffmpeg_binary -hide_banner -buildconf 2>&1)"
available_encoders="$($ffmpeg_binary -hide_banner -encoders 2>&1)"
available_filters="$($ffmpeg_binary -hide_banner -filters 2>&1)"
if grep -q -- '--enable-nonfree' <<<"$build_configuration"; then
  echo "Refusing to package an FFmpeg build with --enable-nonfree" >&2
  exit 1
fi
if grep -q -- '--enable-gpl' <<<"$build_configuration"; then
  echo "Refusing to package a GPL FFmpeg build in the LGPL runtime" >&2
  exit 1
fi
if ! grep -q " $required_encoder " <<<"$available_encoders"; then
  echo "$required_encoder was not built for $platform" >&2
  exit 1
fi
if ! grep -Eq '[[:space:]]ass[[:space:]]' <<<"$available_filters"; then
  echo "The libass subtitle filter was not built" >&2
  exit 1
fi

printf '%s\n' "$build_configuration" > "$runtime_dir/FFMPEG-BUILD-CONFIG.txt"
cp "$source_dir/COPYING.LGPLv2.1" "$runtime_dir/FFMPEG-LGPL-2.1.txt"
cat > "$runtime_dir/FFMPEG-SOURCE.txt" <<EOF
FFmpeg version: $FFMPEG_VERSION
Source: $FFMPEG_SOURCE_URL
SHA-256: $FFMPEG_SHA256
Build script: https://github.com/Mikasathebest/DashCut/blob/main/scripts/build-ffmpeg-runtime.sh
No FFmpeg source patches are applied by DashCut.
EOF
find "$runtime_dir" -type f -print | sed "s#^$runtime_dir/##" | LC_ALL=C sort > "$runtime_dir/RUNTIME-FILES.txt"

echo "Built redistributable LGPL FFmpeg runtime at $runtime_dir"
