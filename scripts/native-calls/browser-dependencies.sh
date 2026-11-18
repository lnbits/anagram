#!/usr/bin/env bash
set -euo pipefail

browser=${1:?Pass the Playwright browser to install}
sources=$(mktemp -d)
config=
cleanup() {
  if [[ -n "$config" ]]; then sudo rm -f "$config"; fi
  rm -rf "$sources"
}
trap cleanup EXIT
chmod 755 "$sources"
node "$(dirname "$0")/apt-sources.mjs" /etc/apt "$sources"
cat > "$sources/apt.conf" <<EOF
Dir::Etc::sourcelist "$sources/sources.list";
Dir::Etc::sourceparts "$sources/sources.list.d";
APT::Update::Error-Mode "any";
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
EOF

# Playwright refreshes the signed indexes and chooses packages for this browser.
# PulseAudio can use those same indexes. Keep the browser download owned by the runner.
config=$(sudo mktemp /etc/apt/apt.conf.d/99anagram-XXXXXXXX)
sudo install -m 0644 "$sources/apt.conf" "$config"
npx playwright install-deps "$browser"
sudo apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils
npx playwright install "$browser"
