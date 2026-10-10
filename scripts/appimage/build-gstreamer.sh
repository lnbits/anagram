#!/usr/bin/env bash
# Build on Ubuntu 22.04: keep its glibc baseline while shipping a call-capable
# GStreamer. WebKitGTK refuses WebM recording with GStreamer older than 1.24.9.
set -euo pipefail
prefix=$(realpath -m "${1:?Pass a dedicated installation directory}")
work=$(realpath -m "${2:?Pass a build/cache directory}")
version=1.26.11
mkdir -p "$prefix" "$work"
export PATH="$prefix/bin:$PATH"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Do not depend on the runner's Meson version or install into system Python.
python3 -m venv "$work/venv"
"$work/venv/bin/pip" install --disable-pip-version-check meson==1.7.2
meson="$work/venv/bin/meson"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
while read -r checksum archive; do
  [[ -n "$checksum" ]] || continue
  project=${archive%-$version.tar.xz}
  if [[ ! -f "$work/$archive" ]]; then
    curl --fail --location --retry 3 --max-time 180 \
      "https://gstreamer.freedesktop.org/src/$project/$archive" -o "$work/$archive"
  fi
  (cd "$work" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check -)
  tar -xf "$work/$archive" -C "$work"
  options=(-Dtests=disabled -Ddoc=disabled)
  [[ "$project" == gst-libav ]] || options+=(-Dexamples=disabled)
  case "$project" in
    gstreamer) options+=(-Dintrospection=disabled -Dbenchmarks=disabled -Dptp-helper=disabled) ;;
    gst-plugins-base) options+=(-Dintrospection=disabled -Dgl=enabled -Dopus=enabled -Dvorbis=enabled -Dogg=enabled -Dalsa=enabled) ;;
    gst-plugins-good) options+=(-Dvpx=enabled -Dpulse=enabled -Dv4l2=enabled) ;;
    gst-plugins-bad) options+=(-Dintrospection=disabled -Dauto_features=disabled -Dopus=enabled -Dvideoparsers=enabled -Dtranscode=enabled -Dautoconvert=enabled) ;;
  esac
  "$meson" setup --reconfigure "$work/$project-build" "$work/$project-$version" \
    --prefix="$prefix" --libdir=lib --libexecdir=libexec --buildtype=release \
    --wrap-mode=nofallback "${options[@]}"
  "$meson" compile -C "$work/$project-build" -j "${CMAKE_BUILD_PARALLEL_LEVEL:-2}"
  "$meson" install -C "$work/$project-build"
  mkdir -p "$prefix/share/licenses/$project"
  cp "$work/$project-$version/COPYING" "$prefix/share/licenses/$project/"
done < "$script_dir/gstreamer.sha256"
"$prefix/bin/gst-inspect-1.0" --version
