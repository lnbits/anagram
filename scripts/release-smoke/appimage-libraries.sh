#!/usr/bin/env bash
# Check the finished bundle, so Ubuntu's installed libraries cannot mask omissions.
set -euo pipefail
appdir=$(realpath "${1:?Pass the extracted AppImage directory}")
libdir="$appdir/usr/lib"
# Display libraries must match the host Mesa/EGL drivers. Old bundled copies
# can fail before WebKit renders, even when the same image works on Ubuntu.
if find "$appdir/usr" \( -type f -o -type l \) \
  \( -name 'libwayland-*.so*' -o -name 'libX11*.so.*' -o -name 'libxcb*.so.*' \
     -o -name 'libXau.so.*' -o -name 'libXdmcp.so.*' \) -print -quit | grep -q .; then
  echo 'AppImage must use host Wayland/X11 libraries; bundled copies conflict with graphics drivers.' >&2
  exit 1
fi
required=(
  libfontconfig.so.1 libfreetype.so.6 libexpat.so.1 libz.so.1 libuuid.so.1
  libharfbuzz.so.0 libfribidi.so.0
  libgpg-error.so.0 libcom_err.so.2
  libgmp.so.10 libasound.so.2 libjack.so.0
  gio/modules/libgiognutls.so
  gstreamer1.0/gstreamer-1.0/gst-plugin-scanner
)
for plugin in playback opus opusparse transcode autoconvert vorbis vpx matroska isomp4 libav; do
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
  printf '\n%s\n' "$binary"
  # readelf also accepts static archives such as gdk-pixbuf's io-wmf.a.
  # Only files with DT_NEEDED entries have shared dependencies to resolve.
  dynamic=$(LC_ALL=C readelf --wide --dynamic "$binary")
  if [[ "$dynamic" != *"(NEEDED)"* ]]; then
    printf '%s\n' 'No shared-library dependencies.'
    continue
  fi
  if ! dependencies=$(LD_LIBRARY_PATH="$libdir" ldd "$binary" 2>&1); then
    printf 'Could not inspect AppImage dependencies for %s:\n%s\n' "$binary" "$dependencies" >&2
    exit 1
  fi
  printf '%s\n' "$dependencies"
  while read -r library arrow resolved rest; do
    [[ "$arrow" == '=>' ]] || continue
    if [[ "$resolved" == not ]]; then
      echo "Unresolved AppImage dependency $library in $binary" >&2
      exit 1
    fi
    case "$library" in
      libc.so.6|libm.so.6|libpthread.so.0|libdl.so.2|librt.so.1|libresolv.so.2|libutil.so.1|libanl.so.1|libnss_*.so.2) continue ;;
      libgcc_s.so.1|libstdc++.so.6) continue ;;
      libX11*.so.*|libxcb*.so.*|libXau.so.*|libXdmcp.so.*) continue ;;
      libwayland-client.so.0|libwayland-cursor.so.0|libwayland-egl.so.1|libwayland-server.so.0) continue ;;
      libGL.so.1|libEGL.so.1|libGLX.so.0|libGLdispatch.so.0|libOpenGL.so.0|libgbm.so.1|libdrm.so.2|libvulkan.so.1) continue ;;
    esac
    if [[ "$resolved" != "$libdir/"* ]]; then
      echo "Dependency $library in $binary is not resolved from the AppImage: $resolved" >&2
      exit 1
    fi
  done <<< "$dependencies"
done < <(find "$appdir/usr" -type f -print0)
