import { verifyEvent, type VerifiedEvent } from 'nostr-tools';

export type RatchetCapability = { createdAt: number; id: string; available: boolean };
export type RatchetDevice = { identityPubkey: string; createdAt: number };
export type RatchetRoster = { createdAt: number; id: string; devices: RatchetDevice[] };

// A roster is public capability evidence; checking it must not register our device.
export async function parseRatchetRoster(
  event: VerifiedEvent,
  peer: string,
): Promise<RatchetRoster | null> {
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
      devices: devices.filter((device) => /^[a-f0-9]{64}$/.test(device.identityPubkey)),
    };
  } catch {
    return null;
  }
}

export async function parseRatchetCapability(
  event: VerifiedEvent,
  peer: string,
): Promise<RatchetCapability | null> {
  const roster = await parseRatchetRoster(event, peer);
  return (
    roster && { createdAt: roster.createdAt, id: roster.id, available: roster.devices.length > 0 }
  );
}
