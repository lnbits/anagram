import { expect, it } from 'vitest';
import { roomVideoProfile } from '#src/services/callVideoProfile.ts';

it('keeps group screen sharing readable within a bounded mesh budget', () => {
  for (let members = 2; members <= 6; members++) {
    const normal = roomVideoProfile(members, false);
    const sharing = roomVideoProfile(members, true);
    expect(normal.cameraBitrate * (members - 1)).toBeLessThanOrEqual(1200000);
    expect((sharing.cameraBitrate + sharing.screenBitrate) * (members - 1)).toBeLessThanOrEqual(
      3600000,
    );
    expect(sharing.screenFrameRate).toBeGreaterThanOrEqual(10);
    expect(sharing.cameraBitrate).toBeLessThan(normal.cameraBitrate);
    if (members >= 4) {
      expect(sharing.screenWidth).toBe(1280);
      expect(sharing.cameraWidth).toBe(320);
    }
  }
});
