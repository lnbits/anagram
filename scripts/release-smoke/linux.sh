#!/usr/bin/env bash
# Run under xvfb-run + dbus-run-session. Never share a user's keychain bus.
set -euo pipefail
image=$(realpath "${1:?Pass the release AppImage}")
output=$(realpath -m "${2:-desktop-smoke-results}")
root=$(cd "$(dirname "$0")/../.." && pwd)
: "${ANAGRAM_DISPOSABLE_TEST:?Run in a disposable test session}"
mkdir -p "$output"
sha256sum "$image" > "$output/artifact.sha256"
if curl -s --max-time 2 http://127.0.0.1:4444/status >/dev/null; then
  echo 'WebDriver port is already in use; refusing to reuse another session.' >&2
  exit 1
fi
state=$(mktemp -d)
export XDG_CONFIG_HOME="$state/config" XDG_DATA_HOME="$state/data" XDG_CACHE_HOME="$state/cache" XDG_RUNTIME_DIR="$state/runtime"
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
export GDK_BACKEND=x11
driver_pid=''
finish() {
  [[ -z "$driver_pid" ]] || kill "$driver_pid" 2>/dev/null || true
  gnome-keyring-daemon --control-directory "$state/keyring" --quit >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap finish EXIT
# Unlock only this isolated session's secret service; restart checks use native storage.
printf '%s' release-smoke | gnome-keyring-daemon --unlock --components=secrets --control-directory "$state/keyring" > "$output/keyring.log" 2>&1
(cd "$state" && "$image" --appimage-extract > "$output/extract.log")
[[ -x "$state/squashfs-root/AppRun" ]]
bash "$root/scripts/release-smoke/appimage-libraries.sh" "$state/squashfs-root" > "$output/libraries.log"
timeout 90s bash "$root/scripts/release-smoke/appimage-media.sh" "$state/squashfs-root" > "$output/media.log" 2>&1
# Reproduce a desktop exporting an incompatible GIO TLS module. GLib discovers
# this filename first and otherwise shadows the working bundled module. The
# AppImage startup must isolate it; desktop.mjs then verifies real WSS relay EOSE.
mkdir "$state/host-gio"
printf '%s\n' 'Incompatible host TLS module (release smoke fixture)' > "$state/host-gio/libgiognutls.so"
printf '%s\n' 'libgiognutls.so: gio-tls-backend' > "$state/host-gio/giomodule.cache"
export GIO_EXTRA_MODULES="$state/host-gio"
tauri-driver > "$output/driver.log" 2>&1 &
driver_pid=$!
for attempt in $(seq 1 30); do
  curl -s http://127.0.0.1:4444/status >/dev/null && break
  kill -0 "$driver_pid"
  sleep 1
done
node "$root/scripts/release-smoke/desktop.mjs" "$state/squashfs-root/AppRun" "$output"
