// Clones keep per-peer lifecycle/mute controls isolated. Encoders share the
// room's original source; WebM consumers use ordered resets for late joins.
const originals = new WeakMap<MediaStreamTrack, MediaStreamTrack>();
export function cloneCallTrack(track: MediaStreamTrack): MediaStreamTrack {
  const clone = track.clone();
  originals.set(clone, originals.get(track) ?? track);
  return clone;
}
export function callCaptureTrack(track: MediaStreamTrack): MediaStreamTrack {
  return originals.get(track) ?? track;
}
