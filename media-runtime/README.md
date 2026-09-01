# Generated FFmpeg runtime

`scripts/build-ffmpeg-runtime.sh` creates `media-runtime/current` for the active platform. The directory contains the FFmpeg executable, its redistributable dynamic dependencies, the exact LGPL text, source URL, checksum, and build configuration.

The generated runtime is never committed. Release jobs build it natively for macOS arm64, macOS x64, and Windows x64 before packaging DashCut.
