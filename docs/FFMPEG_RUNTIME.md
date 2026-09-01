# LGPL FFmpeg runtime

DashCut builds FFmpeg from the pinned official source archive instead of depending on a third-party prebuilt npm binary. Release builds target:

| Installer | FFmpeg encoder | Subtitle renderer |
| --- | --- | --- |
| macOS arm64 | `h264_videotoolbox` | `libass` |
| macOS x64 | `h264_videotoolbox` | `libass` |
| Windows x64 | `h264_mf` (MediaFoundation) | `libass` |

On Windows, export first requests MediaFoundation hardware encoding and automatically retries with its software encoder when hardware encoding is unavailable. VideoToolbox is configured with its native software fallback on macOS.

The common build configuration explicitly disables GPL and nonfree code. `scripts/verify-ffmpeg-runtime.mjs` fails if either `--enable-gpl` or `--enable-nonfree` appears, or if the platform encoder, ASS filter, license, or source notice is missing.

## Native build

macOS requires Xcode Command Line Tools and:

```bash
brew install pkg-config nasm libass
bash scripts/build-ffmpeg-runtime.sh
npm run media:verify
```

Windows builds run in an MSYS2 `MINGW64` shell with `make`, `diffutils`, `nasm`, `pkgconf`, `mingw-w64-x86_64-toolchain`, and `mingw-w64-x86_64-libass` installed:

```bash
bash scripts/build-ffmpeg-runtime.sh
npm run media:verify
```

The generated `media-runtime/current` directory is ignored by Git and copied into Electron `resources/media-runtime` during packaging. End users never install FFmpeg or configure `PATH`.

## Release compliance

For every release, GitHub Actions:

1. downloads the pinned FFmpeg source archive and validates its SHA-256;
2. builds on the native target runner;
3. rejects GPL or nonfree configuration;
4. verifies VideoToolbox or MediaFoundation and the ASS filter;
5. bundles the executable, required dynamic libraries, LGPL text, source notice, and build configuration;
6. attaches the exact FFmpeg source archive, build script, notices, and platform build configurations to the GitHub Release.

See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and the [FFmpeg license checklist](https://ffmpeg.org/legal.html).
