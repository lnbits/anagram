import NDK from '@nostr-dev-kit/ndk';
import { createCallSignalingRuntime } from 'src/stores/nostr/callSignalingRuntime';
import { CALL_PROTOCOL, CALL_SIGNAL_KIND, type CallSignal } from 'src/types/call';
import { describe, expect, it, vi } from 'vitest';

vi.mock('src/services/contactsService', () => ({
  contactsService: {
    getContactByPublicKey: vi.fn(async () => ({
      type: 'user',
      meta: {},
      sendMessagesToAppRelays: false,
      relays: [{ url: 'wss://recipient.example', read: true, write: true }],
    })),
  },
}));

describe('call signaling publication', () => {
  it('sends the dedicated rumor inside a recipient-only gift wrap', async () => {
    const peer = 'a'.repeat(64);
    const own = 'b'.repeat(64);
    const signal: CallSignal = {
      protocol: CALL_PROTOCOL,
      action: 'end',
      reason: 'cancelled',
      callId: crypto.randomUUID(),
      mode: 'audio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const sendRumor = vi.fn().mockResolvedValue({});
    const runtime = createCallSignalingRuntime({
      ndk: new NDK(),
      getOwnPubkey: () => own,
      isBlocked: () => false,
      refreshRelays: vi.fn().mockResolvedValue(undefined),
      getAppRelays: () => [],
      sendRumor,
    });
    await runtime.sendCallSignal(peer.toUpperCase(), signal);
    expect(sendRumor).toHaveBeenCalledWith(
      peer,
      ['wss://recipient.example'],
      CALL_SIGNAL_KIND,
      expect.any(Function),
      { publishSelfCopy: false }
    );
    const factory = sendRumor.mock.calls[0]?.[3];
    const rumor = factory(own, peer, 123);
    expect(rumor.kind).toBe(CALL_SIGNAL_KIND);
    expect(rumor.tags).toEqual([['p', peer]]);
    expect(JSON.parse(rumor.content)).toEqual(signal);
  });
  it('does not publish after an account switch during relay lookup', async () => {
    let own = 'b'.repeat(64);
    const sendRumor = vi.fn();
    const runtime = createCallSignalingRuntime({
      ndk: new NDK(),
      getOwnPubkey: () => own,
      isBlocked: () => false,
      refreshRelays: async () => {
        own = 'c'.repeat(64);
      },
      getAppRelays: () => [],
      sendRumor,
    });
    await expect(
      runtime.sendCallSignal('a'.repeat(64), {
        protocol: CALL_PROTOCOL,
        action: 'end',
        reason: 'hangup',
        callId: crypto.randomUUID(),
        mode: 'audio',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toThrow('unavailable');
    expect(sendRumor).not.toHaveBeenCalled();
  });
});
