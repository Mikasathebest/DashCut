# Third-party notices

DashCut is distributed under the MIT License. The following components bundled with or downloaded by DashCut retain their own licenses.

## FFmpeg

DashCut installers include an unmodified FFmpeg command-line runtime built from FFmpeg 9.0.1 source under the GNU Lesser General Public License version 2.1 or later.

- Upstream: https://ffmpeg.org/
- Exact source: https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz
- SHA-256: `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635`
- Build script: [`scripts/build-ffmpeg-runtime.sh`](scripts/build-ffmpeg-runtime.sh)
- Configuration: LGPL only; `--enable-gpl` and `--enable-nonfree` are prohibited by the release verification step.

Each installer contains the full FFmpeg LGPL text, source notice, actual build configuration, and the redistributable dynamic libraries required by that platform. Each GitHub Release also publishes the exact FFmpeg source archive and platform-specific build configurations.

DashCut invokes the separate FFmpeg executable as a child process and does not link Electron or application code against FFmpeg libraries.

## libass and font rendering dependencies

The FFmpeg runtime uses libass for styled ASS subtitle rendering. Release builds obtain libass and its runtime dependencies from Homebrew on macOS and MSYS2/MinGW-w64 on Windows, copy only libraries reported by the native dynamic linker, and preserve their original library names. Those components retain their respective upstream licenses, including the ISC, MIT, FreeType, and LGPL licenses shipped by their distributors.

- libass: https://github.com/libass/libass
- Homebrew formula metadata: https://formulae.brew.sh/formula/libass
- MSYS2 package metadata: https://packages.msys2.org/packages/mingw-w64-x86_64-libass

## Local speech recognition

Local captions use faster-whisper, CTranslate2, PyAV, and model files selected by the user. Their license files and model terms remain applicable. Model weights are downloaded only after explicit user action and are not included in DashCut installers.

This notice is informational and is not legal advice. Codec patent obligations, where applicable, are separate from open-source copyright licenses.
