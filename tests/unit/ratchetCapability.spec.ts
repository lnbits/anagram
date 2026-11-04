import { describe, expect, it } from 'vitest';
import { AppKeys } from 'nostr-double-ratchet';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools';
import { parseRatchetCapability } from '#src/stores/nostr/ratchetCapability.ts';

const secret = generateSecretKey();
const peer = getPublicKey(secret);
const device = getPublicKey(generateSecretKey());
const now = Math.floor(Date.now() / 1000);
function roster(devices = [device], createdAt = now) {
  return finalizeEvent(
    new AppKeys(
      devices.map((identityPubkey) => ({
        identityPubkey,
        createdAt,
      })),
    ).getEvent({ ownerPubkey: peer, createdAt }),
    secret,
  );
}
function resign(event: VerifiedEvent, changes: Partial<VerifiedEvent>) {
  return finalizeEvent({ ...event, ...changes }, secret);
}

describe('ratchet capability evidence', () => {
  it('returns authenticated ordering evidence and a positive usable device roster', async () => {
    const event = roster();
    expect(await parseRatchetCapability(event, peer)).toEqual({
      createdAt: now,
      id: event.id,
      available: true,
    });
  });

  it('preserves newer empty and unusable-device rosters as negative evidence', async () => {
    for (const event of [roster([], now + 1), roster(['not-a-device'], now + 2)]) {
      expect(await parseRatchetCapability(event, peer)).toEqual({
        createdAt: event.created_at,
        id: event.id,
        available: false,
      });
    }
  });

  it('rejects another author, unrelated facts, invalid signatures and future snapshots', async () => {
    const event = roster();
    expect(await parseRatchetCapability(event, device)).toBeNull();
    const invalidSignature = JSON.parse(JSON.stringify(event));
    invalidSignature.sig = '0'.repeat(128);
    for (const candidate of [
      invalidSignature,
      resign(event, { kind: 1 }),
      resign(event, { tags: event.tags.filter((tag) => tag[0] !== 'type') }),
      roster([device], now + 3600),
      resign(event, { created_at: -1 }),
    ])
      expect(await parseRatchetCapability(candidate, peer)).toBeNull();
  });

  it('rejects signed malformed roster metadata without throwing', async () => {
    const event = roster();
    for (const candidate of [
      resign(event, { content: 'not an empty snapshot' }),
      resign(event, {
        tags: event.tags.map((tag) => (tag[0] === 'schema' ? ['schema', '999'] : tag)),
      }),
      resign(event, {
        tags: event.tags.map((tag) => (tag[0] === 'owner_pubkey' ? ['owner_pubkey', device] : tag)),
      }),
      resign(event, { tags: event.tags.filter((tag) => tag[0] !== 'i') }),
    ])
      expect(await parseRatchetCapability(candidate, peer)).toBeNull();
  });
});
