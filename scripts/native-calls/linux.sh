#!/usr/bin/env bash
# Run inside a disposable display and D-Bus session (see native-calls.yml).
set -euo pipefail
state=$(mktemp -d)
export XDG_CONFIG_HOME="$state/config" XDG_DATA_HOME="$state/data" XDG_CACHE_HOME="$state/cache" XDG_RUNTIME_DIR="$state/runtime"
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
export GDK_BACKEND=x11 NO_AT_BRIDGE=1 XDG_CURRENT_DESKTOP=none GTK_USE_PORTAL=0 GIO_USE_VFS=local
export PULSE_SERVER="unix:$state/pulse"
pulseaudio -n --load="module-native-protocol-unix socket=$state/pulse auth-anonymous=1" \
  --load='module-null-sink sink_name=call_test rate=48000 channels=2' \
  --daemonize=no --exit-idle-time=-1 > "$state/pulse.log" 2>&1 &
pulse_pid=$!
trap 'kill "$pulse_pid" 2>/dev/null || true; rm -rf "$state"' EXIT
node scripts/native-calls/run.mjs --linux
