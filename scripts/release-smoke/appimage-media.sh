#!/usr/bin/env bash
# Decode media using only the packaged GStreamer plugins and a fresh registry.
set -euo pipefail
export APPDIR
APPDIR=$(realpath "${1:?Pass the extracted AppImage directory}")
export LD_LIBRARY_PATH="$APPDIR/usr/lib"
state=$(mktemp -d)
trap 'rm -rf "$state"' EXIT
export GST_REGISTRY_1_0="$state/registry.bin"
source "$APPDIR/apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
for element in playbin decodebin vp8dec vorbisdec opusdec qtdemux avdec_h264 avdec_aac; do
  gst-inspect-1.0 --exists "$element"
done

gst-launch-1.0 -q videotestsrc num-buffers=10 ! video/x-raw,width=160,height=120 ! \
  vp8enc deadline=1 ! webmmux ! filesink location="$state/video.webm"
gst-launch-1.0 -q playbin uri="file://$state/video.webm" video-sink=fakesink audio-sink=fakesink

gst-launch-1.0 -q audiotestsrc num-buffers=10 ! audioconvert ! opusenc ! oggmux ! \
  filesink location="$state/audio.ogg"
gst-launch-1.0 -q playbin uri="file://$state/audio.ogg" video-sink=fakesink audio-sink=fakesink
printf '%s\n' 'Packaged video and audio decoding passed.'
