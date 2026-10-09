#!/usr/bin/env bash
# Check the finished bundle, so Ubuntu's installed libraries cannot mask omissions.
set -euo pipefail
appdir=$(realpath "${1:?Pass the extracted AppImage directory}")
libdir="$appdir/usr/lib"
required=(
  libfontconfig.so.1 libfreetype.so.6 libexpat.so.1 libz.so.1 libuuid.so.1
  libharfbuzz.so.0 libfribidi.so.0 libX11.so.6 libX11-xcb.so.1 libxcb.so.1
  libwayland-client.so.0 libgpg-error.so.0 libcom_err.so.2
  libgmp.so.10 libasound.so.2 libjack.so.0
  gio/modules/libgiognutls.so
  gstreamer1.0/gstreamer-1.0/gst-plugin-scanner
)
for plugin in playback opus vorbis vpx matroska isomp4 libav; do
  required+=("gstreamer-1.0/libgst$plugin.so")
done
for library in "${required[@]}"; do
  if [[ ! -f "$libdir/$library" ]]; then
    echo "AppImage is missing $library" >&2
    exit 1
  fi
done
[[ -f "$appdir/apprun-hooks/linuxdeploy-plugin-gstreamer.sh" ]]

# Audit every ELF, including WebKit subprocesses, GTK modules and media plugins.
# The C/C++ runtime and graphics driver stack must match the host system.
while IFS= read -r -d '' binary; do
  readelf -h "$binary" >/dev/null 2>&1 || continue
  dependencies=$(LD_LIBRARY_PATH="$libdir" ldd "$binary")
  printf '\n%s\n%s\n' "$binary" "$dependencies"
  while read -r library arrow resolved rest; do
    [[ "$arrow" == '=>' ]] || continue
    if [[ "$resolved" == not ]]; then
      echo "Unresolved AppImage dependency $library in $binary" >&2
      exit 1
    fi
    case "$library" in
      libc.so.6|libm.so.6|libpthread.so.0|libdl.so.2|librt.so.1|libresolv.so.2|libutil.so.1|libanl.so.1|libnss_*.so.2) continue ;;
      libgcc_s.so.1|libstdc++.so.6) continue ;;
      libGL.so.1|libEGL.so.1|libGLX.so.0|libGLdispatch.so.0|libOpenGL.so.0|libgbm.so.1|libdrm.so.2|libvulkan.so.1) continue ;;
    esac
    if [[ "$resolved" != "$libdir/"* ]]; then
      echo "Dependency $library in $binary is not resolved from the AppImage: $resolved" >&2
      exit 1
    fi
  done <<< "$dependencies"
done < <(find "$appdir/usr" -type f -print0)
