import { contactsService } from '#src/services/contactsService.ts';
import NostrClient from '#src/lib/nostr/client.ts';
import { createCallSignalingRuntime } from '#src/stores/nostr/callSignalingRuntime.ts';
import { CALL_PROTOCOL, CALL_SIGNAL_KIND, type CallSignal } from '#src/types/call.ts';
import { ROOM_PROTOCOL } from '#src/types/callRoom.ts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('#src/services/contactsService.ts', () => ({
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
      ndk: new NostrClient(),
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
      { publishSelfCopy: false, returnOnFirstAck: true },
    );
    const factory = sendRumor.mock.calls[0]?.[3];
    const rumor = factory(own, peer, 123);
    expect(rumor.kind).toBe(CALL_SIGNAL_KIND);
    expect(rumor.tags).toEqual([['p', peer]]);
    expect(JSON.parse(rumor.content)).toEqual(signal);
  });
  it('publishes room controls to bounded invitation relay hints without creating contacts or self copies', async () => {
    const sendRumor = vi.fn().mockResolvedValue({});
    const refreshRelays = vi.fn();
    const runtime = createCallSignalingRuntime({
      ndk: new NostrClient(),
      getOwnPubkey: () => 'b'.repeat(64),
      isBlocked: () => false,
      refreshRelays,
      getAppRelays: () => [],
      sendRumor,
    });
    const signal = {
      protocol: ROOM_PROTOCOL as typeof ROOM_PROTOCOL,
      action: 'closed' as const,
      roomId: crypto.randomUUID(),
      senderSession: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await runtime.sendRoomSignal('a'.repeat(64), signal, ['wss://room.example']);
    expect(refreshRelays).not.toHaveBeenCalled();
    expect(sendRumor).toHaveBeenCalledWith(
      'a'.repeat(64),
      ['wss://room.example'],
      CALL_SIGNAL_KIND,
      expect.any(Function),
      { publishSelfCopy: false, returnOnFirstAck: true },
    );
    expect(sendRumor.mock.calls[0]?.[3]('b'.repeat(64), 'a'.repeat(64), 123).content).toBe(
      JSON.stringify(signal),
    );
    await expect(
      runtime.sendRoomSignal('a'.repeat(64), signal, ['file:///not-a-relay']),
    ).rejects.toThrow();
  });

  it('keeps using known recipient relays if their metadata refresh times out', async () => {
    const sendRumor = vi.fn().mockResolvedValue({});
    const runtime = createCallSignalingRuntime({
      ndk: new NostrClient(),
      getOwnPubkey: () => 'b'.repeat(64),
      isBlocked: () => false,
      refreshRelays: async () => {
        throw new Error('Relay query timed out');
      },
      getAppRelays: () => [],
      sendRumor,
    });
    await runtime.sendCallSignal('a'.repeat(64), {
      protocol: CALL_PROTOCOL,
      action: 'end',
      reason: 'hangup',
      callId: crypto.randomUUID(),
      mode: 'audio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(sendRumor).toHaveBeenCalledWith(
      'a'.repeat(64),
      ['wss://recipient.example'],
      CALL_SIGNAL_KIND,
      expect.any(Function),
      { publishSelfCopy: false, returnOnFirstAck: true },
    );
  });

  it.each(['account', 'sender', 'blocked'])(
    'rechecks %s when signing a delayed direct signal',
    async (change) => {
      const original = 'b'.repeat(64);
      let own = original;
      let blocked = false;
      const sendRumor = vi.fn().mockResolvedValue({});
      const runtime = createCallSignalingRuntime({
        ndk: new NostrClient(),
        getOwnPubkey: () => own,
        isBlocked: () => blocked,
        refreshRelays: async () => {},
        getAppRelays: () => [],
        sendRumor,
      });
      await runtime.sendCallSignal('a'.repeat(64), {
        protocol: CALL_PROTOCOL,
        action: 'end',
        reason: 'hangup',
        callId: crypto.randomUUID(),
        mode: 'audio',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (change === 'account') own = 'c'.repeat(64);
      if (change === 'blocked') blocked = true;
      const sender = change === 'sender' ? 'c'.repeat(64) : original;
      expect(() => sendRumor.mock.calls[0]?.[3](sender, 'a'.repeat(64), 123)).toThrow(
        'Call session changed',
      );
    },
  );

  it.each([false, true])(
    'always includes app relays; missing recipient inbox: %s',
    async (missing) => {
      vi.mocked(contactsService.getContactByPublicKey).mockResolvedValueOnce({
        type: 'user',
        meta: {},
        sendMessagesToAppRelays: false,
        relays: missing ? [] : [{ url: 'wss://recipient.example', read: true, write: true }],
      } as never);
      const sendRumor = vi.fn().mockResolvedValue({});
      const runtime = createCallSignalingRuntime({
        ndk: new NostrClient(),
        getOwnPubkey: () => 'b'.repeat(64),
        isBlocked: () => false,
        refreshRelays: async () => {
          throw new Error('Metadata timeout');
        },
        getAppRelays: () => ['wss://app.example'],
        sendRumor,
      });
      await runtime.sendCallSignal('a'.repeat(64), {
        protocol: CALL_PROTOCOL,
        action: 'end',
        reason: 'hangup',
        callId: crypto.randomUUID(),
        mode: 'audio',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(sendRumor).toHaveBeenCalledWith(
        'a'.repeat(64),
        missing ? ['wss://app.example'] : ['wss://recipient.example', 'wss://app.example'],
        CALL_SIGNAL_KIND,
        expect.any(Function),
        { publishSelfCopy: false, returnOnFirstAck: true },
      );
    },
  );

  it('does not publish after an account switch during relay lookup', async () => {
    let own = 'b'.repeat(64);
    const sendRumor = vi.fn();
    const runtime = createCallSignalingRuntime({
      ndk: new NostrClient(),
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
      }),
    ).rejects.toThrow('unavailable');
    expect(sendRumor).not.toHaveBeenCalled();
  });
});
