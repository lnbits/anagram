import type { CallVideoProfile } from '#src/stores/nostr/callRuntime.svelte.ts';

// Bound the sender's mesh budget and reserve more of it for readable screens.
export function roomVideoProfile(members: number, sharing: boolean): CallVideoProfile {
  const peers = Math.max(1, Math.min(5, members - 1));
  return {
    cameraBitrate: Math.floor(
      Math.min(sharing ? 300000 : 600000, (sharing ? 600000 : 1200000) / peers),
    ),
    cameraFrameRate: sharing ? 12 : peers <= 2 ? 24 : peers === 3 ? 20 : 15,
    cameraWidth: sharing && peers >= 3 ? 320 : peers >= 3 ? 480 : 640,
    cameraHeight: sharing && peers >= 3 ? 180 : peers >= 3 ? 270 : 360,
    screenBitrate: Math.floor(Math.min(1500000, 3000000 / peers)),
    screenFrameRate: peers <= 2 ? 15 : peers <= 4 ? 12 : 10,
    screenWidth: peers <= 2 ? 1920 : 1280,
    screenHeight: peers <= 2 ? 1080 : 720,
  };
}
