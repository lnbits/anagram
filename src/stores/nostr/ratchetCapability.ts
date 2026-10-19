import { verifyEvent, type VerifiedEvent } from 'nostr-tools';

export type RatchetCapability = { createdAt: number; id: string; available: boolean };

// A roster is public capability evidence; checking it must not register our device.
export async function parseRatchetCapability(
  event: VerifiedEvent,
  peer: string,
): Promise<RatchetCapability | null> {
  try {
    if (
      event.kind !== 37368 ||
      event.pubkey !== peer ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 ||
      event.created_at > Math.floor(Date.now() / 1000) + 300 ||
      !event.tags.some((tag) => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot') ||
      !verifyEvent(event)
    )
      return null;
    // Keep NDR off the initial path and ignore unrelated or forged facts before loading it.
    const { AppKeys } = await import('nostr-double-ratchet');
    const devices = AppKeys.fromEvent(event).getAllDevices();
    return {
      createdAt: event.created_at,
      id: event.id,
      available: devices.some((device) => /^[a-f0-9]{64}$/.test(device.identityPubkey)),
    };
  } catch {
    return null;
  }
}
