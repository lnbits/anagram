#!/usr/bin/env bash
set -euo pipefail
cache=${1:?Pass an apt archive directory}
media_cache_hit=${2?Pass the media cache hit flag}
mkdir -p "$cache"
sources=$(mktemp -d)
chmod 755 "$sources"
trap 'rm -rf "$sources"' EXIT
node "$(dirname "$0")/apt-sources.mjs" "${3:-/etc/apt}" "$sources"
options=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30
  -o "Dir::Etc::sourcelist=$sources/sources.list" -o "Dir::Etc::sourceparts=$sources/sources.list.d"
  -o APT::Update::Error-Mode=any
  -o "Dir::Cache::archives=$cache" -o APT::Keep-Downloaded-Packages=true)

# Refresh signed indexes even when reusing downloaded packages. apt still checks
# package versions and hashes; the cache never substitutes for package validation.
sudo apt-get "${options[@]}" update
packages=(libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  xvfb xdotool dbus-x11 pulseaudio build-essential pkg-config
  libopus0 libvpx9 libogg0 libvorbis0a libvorbisenc2 libvorbisfile3
  libpulse0 libasound2t64 libavcodec60 libavformat60 libavfilter9
  libswresample4 libswscale7 libjpeg-turbo8 libpng16-16t64 libtheora0
  libgudev-1.0-0 liborc-0.4-0)
if [[ "$media_cache_hit" != true ]]; then
  packages+=(ninja-build bison flex python3-venv patch
    libopus-dev libvpx-dev libogg-dev libvorbis-dev libpulse-dev libasound2-dev
    libavcodec-dev libavformat-dev libavfilter-dev libswresample-dev libswscale-dev
    libjpeg-dev libpng-dev libtheora-dev libgudev-1.0-dev liborc-0.4-dev)
fi
sudo apt-get "${options[@]}" install -y --no-install-recommends "${packages[@]}"
