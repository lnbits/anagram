import { contactsService } from '#src/services/contactsService.ts';
import NostrClient from '#src/lib/nostr/client.ts';
import { createCallSignalingRuntime } from '#src/stores/nostr/callSignalingRuntime.ts';
import { CALL_PROTOCOL, CALL_SIGNAL_KIND, type CallSignal } from '#src/types/call.ts';
import { ROOM_PROTOCOL } from '#src/types/callRoom.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
afterEach(() => vi.mocked(contactsService.getContactByPublicKey).mockReset().mockResolvedValue({
  type: 'user', meta: {}, sendMessagesToAppRelays: false,
  relays: [{ url: 'wss://recipient.example', read: true, write: true }],
} as never));

describe('call signaling publication', () => {
  it.each(['call', 'room'])('sends selected DR %s controls without legacy routes or discovery', async (kind) => {
    const peer = 'a'.repeat(64), own = 'b'.repeat(64);
    vi.mocked(contactsService.getContactByPublicKey).mockResolvedValueOnce({ type: 'user', meta: {}, relays: [] } as never);
    const refreshRelays = vi.fn(() => new Promise<void>(() => {}));
    const getAppRelays = vi.fn(() => []);
    const sendRumor = vi.fn(), sendRatchet = vi.fn(async (_peer, event) => event);
    const runtime = createCallSignalingRuntime({ ndk: new NostrClient(), getOwnPubkey: () => own,
      isBlocked: () => false, refreshRelays, getAppRelays, sendRumor, sendRatchet });
    if (kind === 'call') await runtime.sendCallSignal(peer, {
      protocol: CALL_PROTOCOL, action: 'end', reason: 'hangup', callId: crypto.randomUUID(),
      mode: 'audio', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    else await runtime.sendRoomSignal(peer, { protocol: ROOM_PROTOCOL, action: 'closed',
      roomId: crypto.randomUUID(), senderSession: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, []);
    expect(sendRatchet).toHaveBeenCalledOnce();
    expect(sendRumor).not.toHaveBeenCalled();
    expect(refreshRelays).not.toHaveBeenCalled();
    expect(getAppRelays).not.toHaveBeenCalled();
  });

  it.each([['call', 'group'], ['call', 'blocked'], ['room', 'group'], ['room', 'blocked']])(
    'rejects %s controls for a local %s peer before either transport', async (kind, reason) => {
      const sendRatchet = vi.fn(async (_peer, event) => event), sendRumor = vi.fn(), refreshRelays = vi.fn();
      if (reason === 'group') vi.mocked(contactsService.getContactByPublicKey)
        .mockResolvedValueOnce({ type: 'group', meta: {}, relays: [] } as never);
      const runtime = createCallSignalingRuntime({ ndk: new NostrClient(), getOwnPubkey: () => 'b'.repeat(64),
        isBlocked: () => reason === 'blocked', refreshRelays, getAppRelays: () => [], sendRumor, sendRatchet });
      const sending = kind === 'call' ? runtime.sendCallSignal('a'.repeat(64), {
        protocol: CALL_PROTOCOL, action: 'end', reason: 'hangup', callId: crypto.randomUUID(),
        mode: 'audio', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }) : runtime.sendRoomSignal('a'.repeat(64), { protocol: ROOM_PROTOCOL, action: 'closed',
        roomId: crypto.randomUUID(), senderSession: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString() }, ['wss://room.example']);
      await expect(sending).rejects.toThrow();
      expect(sendRatchet).not.toHaveBeenCalled();
      expect(sendRumor).not.toHaveBeenCalled();
      expect(refreshRelays).not.toHaveBeenCalled();
    },
  );

  it.each(['call', 'room'])('uses the selected ratchet for %s controls without a gift-wrap fallback', async (kind) => {
    const own = 'b'.repeat(64), peer = 'a'.repeat(64);
    const sendRumor = vi.fn();
    let failure: Error | undefined;
    const sendRatchet = vi.fn(async (_peer, event) => {
      if (failure) throw failure;
      return event;
    });
    const runtime = createCallSignalingRuntime({
      ndk: new NostrClient(), getOwnPubkey: () => own, isBlocked: () => false,
      refreshRelays: async () => {}, getAppRelays: () => [], sendRumor, sendRatchet,
    });
    const send = () => kind === 'call' ? runtime.sendCallSignal(peer, {
      protocol: CALL_PROTOCOL, action: 'end', reason: 'hangup', callId: crypto.randomUUID(),
      mode: 'audio', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }) : runtime.sendRoomSignal(peer, {
      protocol: ROOM_PROTOCOL, action: 'closed', roomId: crypto.randomUUID(),
      senderSession: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, ['wss://room.example']);
    await send();
    expect(sendRatchet).toHaveBeenCalledWith(peer, expect.objectContaining({
      kind: CALL_SIGNAL_KIND, pubkey: own, tags: [['p', peer]],
    }));
    expect(sendRumor).not.toHaveBeenCalled();
    failure = new Error('Ratchet session unavailable');
    await expect(send()).rejects.toThrow(failure);
    expect(sendRumor).not.toHaveBeenCalled();
  });

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
      sendRatchet: async () => null,
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
      sendRatchet: async () => null,
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
      sendRatchet: async () => null,
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
        sendRatchet: async () => null,
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
        sendRatchet: async () => null,
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
      sendRatchet: async () => null,
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

it('sends through cached routes while metadata discovery is stalled', async () => {
  const sendRumor = vi.fn().mockResolvedValue({});
  const runtime = createCallSignalingRuntime({
    ndk: new NostrClient(),
    getOwnPubkey: () => 'b'.repeat(64),
    isBlocked: () => false,
    refreshRelays: () => new Promise(() => {}),
    getAppRelays: () => [],
    sendRumor,
    sendRatchet: async () => null,
  });
  await runtime.sendCallSignal('a'.repeat(64), {
    protocol: CALL_PROTOCOL,
    action: 'end',
    reason: 'hangup',
    callId: crypto.randomUUID(),
    mode: 'audio',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(sendRumor).toHaveBeenCalledOnce();
});

it('retries failed cached delivery using freshly discovered routes', async () => {
  vi.mocked(contactsService.getContactByPublicKey)
    .mockResolvedValueOnce({
      type: 'user',
      meta: {},
      relays: [{ url: 'wss://old.example', read: true }],
    } as never)
    .mockResolvedValueOnce({
      type: 'user',
      meta: {},
      relays: [{ url: 'wss://new.example', read: true }],
    } as never);
  const sendRumor = vi
    .fn()
    .mockRejectedValueOnce(new Error('Old relay offline'))
    .mockResolvedValue({});
  const runtime = createCallSignalingRuntime({
    ndk: new NostrClient(),
    getOwnPubkey: () => 'b'.repeat(64),
    isBlocked: () => false,
    refreshRelays: async () => {},
    getAppRelays: () => [],
    sendRumor,
    sendRatchet: async () => null,
  });
  await runtime.sendCallSignal('a'.repeat(64), {
    protocol: CALL_PROTOCOL,
    action: 'end',
    reason: 'hangup',
    callId: crypto.randomUUID(),
    mode: 'audio',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(sendRumor.mock.calls.map((args) => args[1])).toEqual([
    ['wss://old.example'],
    ['wss://new.example'],
  ]);
});
