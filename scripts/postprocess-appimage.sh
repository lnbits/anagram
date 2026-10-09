#!/usr/bin/env bash
set -euo pipefail

input="${1:?usage: postprocess-appimage.sh INPUT.AppImage [OUTPUT.AppImage]}"
output="${2:-$input}"

if [[ ! -f "$input" ]]; then
  echo "AppImage not found: $input" >&2
  exit 1
fi

case "$output" in
  *.AppImage) ;;
  *)
    echo "Output must end in .AppImage: $output" >&2
    exit 1
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input="$(realpath "$input")"
output_dir="$(cd "$(dirname "$output")" && pwd)"
output="$output_dir/$(basename "$output")"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/anagram-appimage.XXXXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT

(
  cd "$work_dir"
  "$input" --appimage-extract >/dev/null
)

app_dir="$work_dir/squashfs-root"
if [[ ! -x "$app_dir/usr/bin/anagram" ]]; then
  echo "The AppImage does not contain usr/bin/anagram" >&2
  exit 1
fi

# Keep the display libraries consistent with the host's Mesa/EGL drivers.
# This is the same exclusion used by Napstr's working AppImage packaging.
find "$app_dir/usr/lib" -maxdepth 1 \
  \( -type f -o -type l \) \
  \( -name 'libwayland-*.so*' -o -name 'libX11*.so.*' -o -name 'libxcb*.so.*' \
     -o -name 'libXau.so.*' -o -name 'libXdmcp.so.*' \) -delete

install -m 0755 "$script_dir/appimage/AppRun" "$app_dir/AppRun"

repacked="$work_dir/$(basename "$output")"
architecture="${ARCH:-$(uname -m)}"
case "$architecture" in
  amd64) architecture=x86_64 ;;
  arm64) architecture=aarch64 ;;
esac

if [[ -n "${APPIMAGETOOL:-}" ]]; then
  ARCH="$architecture" "$APPIMAGETOOL" "$app_dir" "$repacked"
else
  plugin="${TAURI_APPIMAGE_PLUGIN:-${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage}"
  if [[ ! -x "$plugin" ]]; then
    echo "Tauri's AppImage plugin was not found at: $plugin" >&2
    exit 1
  fi

  (
    cd "$work_dir"
    ARCH="$architecture" \
      LDAI_OUTPUT="$repacked" \
      APPIMAGE_EXTRACT_AND_RUN=1 \
      "$plugin" --appdir="$app_dir"
  )
fi

if [[ ! -s "$repacked" ]]; then
  echo "AppImage repacking did not create: $repacked" >&2
  exit 1
fi

chmod 0755 "$repacked"
mv -f -- "$repacked" "$output"
echo "Repaired AppImage: $output"
