import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NostrClient, { ClientEvent, NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { createGroupRecoveryRuntime } from '#src/stores/nostr/groupRecoveryRuntime.ts';
import {
  groupEntropyFromPhrase,
  deriveGroupEpochKey,
  GROUP_RECOVERY_TAG,
} from '#src/stores/nostr/groupRecovery.ts';
import { verifyGroupMembershipProof } from '#src/stores/nostr/groupMessageAuthorization.ts';
import type { ContactRecord } from '#src/types/contact.ts';

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const ndk = new NostrClient();
  vi.spyOn(ndk, 'fetchEvents').mockResolvedValue(new Set());
  const owner = NostrPrivateKeySigner.generate();
  let account = owner.pubkey;
  let contact: ContactRecord | null = null;
  const events: ClientEvent[] = [];
  const storedOn = new Map<string, Set<string>>();
  const unavailable = new Set<string>();
  const stalled = new Set<string>();
  const stopped = vi.fn();
  const rejectWrites = new Set<string>();
  const unretained = new Set<string>();
  const persistEpoch = vi.fn(async () => {});
  const publish = vi.fn(async (event: ClientEvent, relays: string[]) => {
    events.push(event);
    for (const relay of relays) {
      if (rejectWrites.has(relay) || unretained.has(relay)) continue;
      const ids = storedOn.get(relay) ?? new Set<string>();
      ids.add(event.id);
      storedOn.set(relay, ids);
    }
    return {
      error: null,
      relayStatuses: relays.map((relay_url) => ({
        relay_url,
        status: rejectWrites.has(relay_url) ? ('failed' as const) : ('published' as const),
        direction: 'outbound' as const,
        scope: 'self' as const,
      })),
    };
  });
  vi.spyOn(ndk, 'subscribe').mockImplementation((filter: any, options: any) => {
    const listeners: Record<string, Function> = {};
    return {
      on: (name: string, callback: Function) => {
        listeners[name] = callback;
      },
      stop: stopped,
      start: () =>
        queueMicrotask(() => {
          if (stalled.has(options.relayUrls[0])) return;
          if (unavailable.has(options.relayUrls[0])) {
            listeners.closed?.();
            return;
          }
          for (const event of events
            .filter(
              (e) =>
                storedOn.get(options.relayUrls[0])?.has(e.id) &&
                e.pubkey === filter.authors[0] &&
                (!filter.ids || filter.ids.includes(e.id)) &&
                (!filter['#t'] ||
                  e.tags.some((tag) => tag[0] === 't' && filter['#t'].includes(tag[1]))) &&
                (filter.until === undefined || e.created_at <= filter.until),
            )
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit))
            listeners.event?.(event);
          listeners.eose?.();
        }),
    } as any;
  });
  vi.spyOn(contactsService, 'getContactByPublicKey').mockImplementation(async () => contact);
  vi.spyOn(contactsService, 'updateContact').mockImplementation(async (_id, update) => {
    contact = { ...contact!, ...update };
    contact.meta = inputSanitizerService.normalizeContactMetadata(contact.meta);
    return contact;
  });
  const dependencies = {
    ndk,
    account: () => account,
    connect: vi.fn(async () => {}),
    encrypt: async (secret: unknown) => JSON.stringify(secret),
    decrypt: async (value: string) => JSON.parse(value),
    saveContact: async (key: string, ciphertext: string) => {
      contact = {
        id: 1,
        public_key: key,
        type: 'group',
        name: 'Group',
        given_name: null,
        meta: { group_private_key_encrypted: ciphertext, owner_public_key: account },
        relays: [],
        sendMessagesToAppRelays: false,
      };
      return true;
    },
    persistEpoch,
    publish: publish as any,
    publishAccountBackup: vi.fn(async () => {}),
    changed: vi.fn(),
    defaultRelays: () => ['wss://relay.example/'],
  };
  return {
    runtime: createGroupRecoveryRuntime(dependencies),
    dependencies,
    owner,
    events,
    unavailable,
    stalled,
    stopped,
    rejectWrites,
    unretained,
    persistEpoch,
    publish,
    forget: () => {
      contact = null;
    },
    changeAccount: (key: string) => {
      account = key;
    },
  };
}
describe('group recovery journal', () => {
  it('does not let a delayed recovery read roll back a concurrent verified update', async () => {
    const f = fixture();
    const secret = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const getContact = vi.mocked(contactsService.getContactByPublicKey);
    const original = getContact.getMockImplementation()!;
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    getContact.mockImplementationOnce(original).mockImplementationOnce(async (...args) => {
      const contact = await original(...args);
      reached();
      await gate;
      return contact;
    });
    const reading = f.runtime.current(secret.group_pubkey);
    void reading.catch(() => {});
    await paused;
    let next;
    try {
      next = await f.runtime.update(secret.group_pubkey, [f.owner.pubkey], false, true);
    } finally {
      resume();
    }
    expect((await reading).recovery_state_id).toBe(next.recovery_state_id);
    await expect(
      f.runtime.assertCanSend(
        secret.group_pubkey,
        new NostrPrivateKeySigner(next.epoch_privkey!).pubkey,
      ),
    ).resolves.toBeUndefined();
  });
  it('issues a missing owner ticket for the current epoch without changing membership or publishing a new state', async () => {
    const f = fixture();
    const secret = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const epochPublicKey = new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey;
    f.persistEpoch.mockClear();
    f.publish.mockClear();
    const invitation = await f.runtime.issueOwnInvitation(secret.group_pubkey, epochPublicKey);
    expect(invitation).not.toBeNull();
    const ticketId = await verifyGroupMembershipProof(
      {
        groupPublicKey: secret.group_pubkey,
        epochNumber: secret.epoch_number!,
        epochPublicKey,
        epochPrivateKey: secret.epoch_privkey!,
      },
      f.owner.pubkey,
      invitation!.invitedAt,
      invitation!.proof,
    );
    expect(ticketId).toMatch(/^[0-9a-f]{64}$/);
    expect(f.persistEpoch).toHaveBeenCalledExactlyOnceWith(
      secret.group_pubkey,
      secret.epoch_number,
      secret.epoch_privkey,
      {
        invitationCreatedAt: new Date(invitation!.invitedAt * 1000).toISOString(),
        invitationProof: invitation!.proof,
        invitationEventId: ticketId,
      },
    );
    expect(f.publish).not.toHaveBeenCalled();
    expect((await f.runtime.secretFor(secret.group_pubkey)).recovery_state_id).toBe(
      secret.recovery_state_id,
    );
  });
  it('does not issue personal tickets to master holders who have not joined', async () => {
    const f = fixture();
    const secret = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    f.changeAccount(NostrPrivateKeySigner.generate().pubkey);
    f.persistEpoch.mockClear();
    await expect(
      f.runtime.issueOwnInvitation(
        secret.group_pubkey,
        new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey,
      ),
    ).rejects.toThrow('not a group member');
    expect(f.persistEpoch).not.toHaveBeenCalled();
  });
  it('does not issue tickets for a stale epoch or when no relay completes recovery', async () => {
    const f = fixture();
    const secret = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const oldEpoch = new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey;
    const next = await f.runtime.update(secret.group_pubkey, [f.owner.pubkey], false, true);
    f.persistEpoch.mockClear();
    await expect(f.runtime.issueOwnInvitation(secret.group_pubkey, oldEpoch)).rejects.toThrow(
      'epoch changed',
    );
    f.unavailable.add('wss://relay.example/');
    await expect(
      f.runtime.issueOwnInvitation(
        secret.group_pubkey,
        new NostrPrivateKeySigner(next.epoch_privkey!).pubkey,
      ),
    ).rejects.toThrow('No relay completed');
    expect(f.persistEpoch).not.toHaveBeenCalled();
  });
  it('returns no owner ticket for an ordinary member and cancels issuance on an account change', async () => {
    const f = fixture();
    const secret = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const epochPublicKey = new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey;
    f.persistEpoch.mockClear();
    const decrypt = f.dependencies.decrypt;
    f.dependencies.decrypt = async (value) => {
      f.changeAccount(NostrPrivateKeySigner.generate().pubkey);
      return decrypt(value);
    };
    await expect(
      createGroupRecoveryRuntime(f.dependencies).issueOwnInvitation(
        secret.group_pubkey,
        epochPublicKey,
      ),
    ).rejects.toThrow('active account changed');
    expect(f.persistEpoch).not.toHaveBeenCalled();
    f.forget();
    await expect(
      f.runtime.issueOwnInvitation(secret.group_pubkey, epochPublicKey),
    ).resolves.toBeNull();
  });
  it('retains the latest verified state after reload even if account hydration replays an older backup', async () => {
    const f = fixture();
    const original = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const next = await f.runtime.update(original.group_pubkey, [
      f.owner.pubkey,
      NostrPrivateKeySigner.generate().pubkey,
    ]);
    await f.dependencies.saveContact(original.group_pubkey, JSON.stringify(original));
    const reloaded = createGroupRecoveryRuntime(f.dependencies);
    expect((await reloaded.current(original.group_pubkey)).recovery_state_id).toBe(
      next.recovery_state_id,
    );
    await f.dependencies.saveContact(original.group_pubkey, JSON.stringify(original));
    expect((await reloaded.secretFor(original.group_pubkey)).recovery_state_id).toBe(
      next.recovery_state_id,
    );
    await expect(
      reloaded.current(original.group_pubkey, original.recovery_state_id),
    ).rejects.toThrow('state changed');
    // A delayed/incomplete older relay snapshot must not roll back a verified head.
    f.events.splice(
      f.events.findIndex((event) => event.id === next.recovery_state_id),
      1,
    );
    expect((await reloaded.current(original.group_pubkey)).recovery_state_id).toBe(
      next.recovery_state_id,
    );
    expect((await reloaded.secretFor(original.group_pubkey)).recovery_state_id).toBe(
      next.recovery_state_id,
    );
  });
  it('recovers every epoch on a fresh account without the original owner backup', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Recovery group', '', ['wss://relay.example/']);
    const member = NostrPrivateKeySigner.generate().pubkey;
    const added = await f.runtime.update(group.group_pubkey, [f.owner.pubkey, member]);
    expect(added.epoch_number).toBe(0); // Adding retains the existing epoch/ticket behavior.
    const rotated = await f.runtime.update(group.group_pubkey, [f.owner.pubkey], false, true);
    expect(rotated.epoch_number).toBe(1);
    expect(rotated.epoch_privkey).not.toBe(group.epoch_privkey);
    expect(
      f.events.every(
        (e) => !e.content.includes(phrase) && !e.content.includes(group.recovery_entropy!),
      ),
    ).toBe(true);
    expect(f.persistEpoch.mock.calls.some((c: any[]) => Boolean(c[3]?.invitationProof))).toBe(true);
    f.forget();
    f.changeAccount(NostrPrivateKeySigner.generate().pubkey);
    f.persistEpoch.mockClear();
    const restored = await f.runtime.restore(phrase);
    expect(f.persistEpoch.mock.calls.every((c: any[]) => !c[3]?.invitationProof)).toBe(true);
    expect(restored.group_privkey).toBe(group.group_privkey);
    expect(restored.epoch_privkey).toBe(rotated.epoch_privkey);
    expect(
      f.persistEpoch.mock.calls.some((c: any[]) => c[1] === 0 && c[2] === group.epoch_privkey),
    ).toBe(true);
    expect(
      f.persistEpoch.mock.calls.some((c: any[]) => c[1] === 1 && c[2] === rotated.epoch_privkey),
    ).toBe(true);
  });
  it('creates a group using verified relays when another candidate is unavailable', async () => {
    const f = fixture();
    f.unavailable.add('wss://offline.example/');
    const group = await f.runtime.create(phrase, 'Group', '', [
      'wss://offline.example/',
      'wss://relay.example/',
    ]);
    expect(group.recovery_state!.relays).toEqual(['wss://relay.example/']);
    const updated = await f.runtime.update(group.group_pubkey, [f.owner.pubkey], false, true);
    expect(updated.epoch_number).toBe(1);
  });
  it('excludes read-only relays and relays that acknowledge without retaining the probe', async () => {
    const f = fixture();
    f.rejectWrites.add('wss://readonly.example/');
    f.unretained.add('wss://discard.example/');
    const group = await f.runtime.create(phrase, 'Group', '', [
      'wss://readonly.example/',
      'wss://discard.example/',
      'wss://relay.example/',
    ]);
    expect(group.recovery_state!.relays).toEqual(['wss://relay.example/']);
  });
  it('does not create a local group if no relay can store its recovery records', async () => {
    const f = fixture();
    f.rejectWrites.add('wss://relay.example/');
    await expect(f.runtime.create(phrase, 'Group', '', ['wss://relay.example/'])).rejects.toThrow(
      'store and return',
    );
    expect(f.persistEpoch).not.toHaveBeenCalled();
    expect(
      f.events.filter((event) => event.tags.some((tag) => tag[1] === GROUP_RECOVERY_TAG)),
    ).toHaveLength(0);
  });
  it.each(['offline', 'stalled'])(
    'updates membership and rotates keys with one %s replica',
    async (failure) => {
      const f = fixture();
      const urls = ['wss://relay.example/', 'wss://second.example/'];
      const group = await f.runtime.create(phrase, 'Group', '', urls);
      const member = NostrPrivateKeySigner.generate().pubkey;
      await f.runtime.update(group.group_pubkey, [f.owner.pubkey, member]);
      (failure === 'stalled' ? f.stalled : f.unavailable).add(urls[1]);
      f.rejectWrites.add(urls[1]);
      f.publish.mockClear();
      f.stopped.mockClear();
      const start = Date.now();
      const next = await f.runtime.update(group.group_pubkey, [f.owner.pubkey]);
      expect(Date.now() - start).toBeLessThan(2500);
      expect(next.epoch_number).toBe(1);
      expect(next.recovery_state!.members).toEqual([f.owner.pubkey]);
      expect(next.recovery_state!.relays).toEqual(urls);
      expect(f.publish.mock.calls.some(([, relays]) => relays.includes(urls[1]))).toBe(true);
      expect(f.stopped).toHaveBeenCalled();
      // A fresh runtime must be able to restore the whole chain from the healthy replica.
      const restored = await createGroupRecoveryRuntime(f.dependencies).inspect(phrase, urls);
      expect(restored.heads[0].id).toBe(next.recovery_state_id);
      // Repair a replica once it returns, using original signed history.
      f.stalled.clear();
      f.unavailable.clear();
      f.rejectWrites.clear();
      await f.runtime.refresh(group.group_pubkey);
      const repaired = await createGroupRecoveryRuntime(f.dependencies).inspect(phrase, [urls[1]]);
      expect(repaired.heads[0].id).toBe(next.recovery_state_id);
    },
  );

  it('ordinary sending checks local keys without requiring a recovery relay read', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    f.unavailable.add('wss://relay.example/');
    const subscribe = vi.mocked(f.dependencies.ndk.subscribe);
    subscribe.mockClear();
    const epoch = new NostrPrivateKeySigner(group.epoch_privkey!).pubkey;
    await f.runtime.assertCanSend(group.group_pubkey, epoch);
    // The same check works after a reload with the encrypted group snapshot.
    await createGroupRecoveryRuntime(f.dependencies).assertCanSend(group.group_pubkey, epoch);
    expect(subscribe).not.toHaveBeenCalled();
    await expect(f.runtime.assertCanSend(group.group_pubkey, f.owner.pubkey)).rejects.toThrow(
      'epoch changed',
    );
  });

  it('a stalled publish cannot hold up an acknowledged update', async () => {
    const f = fixture();
    const urls = ['wss://relay.example/', 'wss://second.example/'];
    const group = await f.runtime.create(phrase, 'Group', '', urls);
    const publish = f.publish.getMockImplementation()!;
    let release!: () => void;
    f.publish.mockImplementation(async (event, relays) => {
      if (relays.includes(urls[1]))
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return publish(event, relays);
    });
    const next = await f.runtime.update(group.group_pubkey, [f.owner.pubkey], false, true);
    expect(next.epoch_number).toBe(1);
    // Delayed continuations must not publish more records under another account.
    f.changeAccount(NostrPrivateKeySigner.generate().pubkey);
    f.publish.mockClear();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('fails a management update if every replica rejects its publication', async () => {
    const f = fixture();
    const urls = ['wss://relay.example/', 'wss://second.example/'];
    const group = await f.runtime.create(phrase, 'Group', '', urls);
    urls.forEach((url) => f.rejectWrites.add(url));
    f.persistEpoch.mockClear();
    await expect(
      f.runtime.update(group.group_pubkey, [f.owner.pubkey], false, true),
    ).rejects.toThrow('No recovery relay saved');
    expect(f.persistEpoch).not.toHaveBeenCalled();
    expect((await f.runtime.secretFor(group.group_pubkey)).recovery_state_id).toBe(
      group.recovery_state_id,
    );
  });
  it('never replaces an existing journal while selecting initial relays', async () => {
    const f = fixture();
    await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    f.unavailable.add('wss://offline.example/');
    f.publish.mockClear();
    await expect(
      f.runtime.create(phrase, 'Group', '', ['wss://offline.example/', 'wss://relay.example/']),
    ).rejects.toThrow('Use Restore group');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('does not install an epoch when its recovery record has no publication acknowledgements', async () => {
    const f = fixture();
    const publish = f.publish.getMockImplementation()!;
    f.publish
      .mockImplementationOnce(publish)
      .mockImplementationOnce(async () => ({ error: null, relayStatuses: [] }));
    await expect(f.runtime.create(phrase, 'Group', '', ['wss://relay.example/'])).rejects.toThrow(
      'No recovery relay saved',
    );
    expect(f.persistEpoch).not.toHaveBeenCalled();
  });
  it('detects concurrent owners, preserves both branch keys and reconciles removals', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const a = NostrPrivateKeySigner.generate().pubkey,
      b = NostrPrivateKeySigner.generate().pubkey;
    await f.runtime.update(group.group_pubkey, [f.owner.pubkey, a, b]);
    // Two devices have the same prior head, then publish independently through a partition.
    const parent = await f.runtime.secretFor(group.group_pubkey);
    const left = await f.runtime.update(group.group_pubkey, [f.owner.pubkey, a]);
    const leftEvent = f.events.pop()!;
    await f.dependencies.saveContact(group.group_pubkey, JSON.stringify(parent));
    const right = await createGroupRecoveryRuntime(f.dependencies).update(group.group_pubkey, [
      f.owner.pubkey,
      b,
    ]);
    f.events.push(leftEvent);
    expect(left.epoch_number).toBe(right.epoch_number);
    expect(left.epoch_privkey).not.toBe(right.epoch_privkey);
    await expect(f.runtime.assertCurrent(group.group_pubkey)).rejects.toThrow('changed');
    await expect(
      f.runtime.assertCanSend(
        group.group_pubkey,
        new NostrPrivateKeySigner(left.epoch_privkey!).pubkey,
      ),
    ).rejects.toThrow('state changed');
    await expect(
      createGroupRecoveryRuntime(f.dependencies).assertCanSend(
        group.group_pubkey,
        new NostrPrivateKeySigner(right.epoch_privkey!).pubkey,
      ),
    ).rejects.toThrow('state changed');
    await expect(f.runtime.update(group.group_pubkey, [f.owner.pubkey, a])).rejects.toThrow(
      'Conflicting group recovery updates',
    );
    const merged = await f.runtime.refresh(group.group_pubkey, true);
    expect(merged.recovery_state!.members).toEqual([f.owner.pubkey]);
    expect(merged.epoch_number).toBe(2);
    expect(merged.epoch_privkey).toBe(
      deriveGroupEpochKey(groupEntropyFromPhrase(phrase), 2, merged.recovery_state!.epoch_revision),
    );
    await expect(f.runtime.assertCurrent(group.group_pubkey)).resolves.toBeUndefined();
  });
  it('uses the journal for ticket and send checks even when an account backup restores an older snapshot', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    const member = NostrPrivateKeySigner.generate().pubkey;
    const next = await f.runtime.update(group.group_pubkey, [f.owner.pubkey, member]);
    await f.dependencies.saveContact(group.group_pubkey, JSON.stringify(group));
    const current = await f.runtime.current(group.group_pubkey, next.recovery_state_id);
    expect(current.recovery_state!.members).toContain(member);
    const epochPubkey = new NostrPrivateKeySigner(current.epoch_privkey!).pubkey;
    await expect(f.runtime.assertCanSend(group.group_pubkey, epochPubkey)).resolves.toBeUndefined();
    await expect(f.runtime.assertCanSend(group.group_pubkey, member)).rejects.toThrow(
      'epoch changed',
    );
    // Local verified state survives hydration replay; a fresh device with only
    // the old snapshot must still review the newer journal before editing.
    expect((await f.runtime.secretFor(group.group_pubkey)).recovery_state_id).toBe(
      next.recovery_state_id,
    );
    await expect(
      createGroupRecoveryRuntime(f.dependencies).update(group.group_pubkey, [f.owner.pubkey]),
    ).rejects.toThrow('Group recovery state has changed');
  });
  it('copies the signed recovery history before advertising new relays', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    await f.runtime.update(group.group_pubkey, [f.owner.pubkey], false, true);
    const originalIds = [
      ...new Set(
        f.events
          .filter((event) =>
            event.tags.some((tag) => tag[0] === 't' && tag[1] === GROUP_RECOVERY_TAG),
          )
          .map((event) => event.id),
      ),
    ];
    f.publish.mockClear();
    await f.runtime.moveRelays(group.group_pubkey, ['wss://new.example/']);
    const calls = f.publish.mock.calls.filter(([, relays]) =>
      relays.includes('wss://new.example/'),
    );
    // Relays return history newest-first; crossing a second can change its order.
    // Every original record must still be copied before the new relay announcement.
    expect(
      calls
        .slice(0, originalIds.length)
        .map(([event]) => event.id)
        .sort(),
    ).toEqual([...originalIds].sort());
    expect(
      calls
        .slice(0, originalIds.length)
        .every(([, relays]) => relays.includes('wss://new.example/')),
    ).toBe(true);
    const secret = await f.runtime.secretFor(group.group_pubkey);
    expect(secret.recovery_state!.relays).toEqual(['wss://new.example/']);
    expect(secret.epoch_number).toBe(1);
  });
  it('moves recovery using one healthy new relay when another new replica fails', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    f.rejectWrites.add('wss://failed.example/');
    await f.runtime.moveRelays(group.group_pubkey, ['wss://failed.example/', 'wss://new.example/']);
    const restored = await createGroupRecoveryRuntime(f.dependencies).inspect(phrase, [
      'wss://new.example/',
    ]);
    expect(restored.heads[0].state.relays).toEqual(['wss://failed.example/', 'wss://new.example/']);
  });
  it('does not advertise a relay move if no new replica saves the complete history', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    f.rejectWrites.add('wss://failed.example/');
    f.publish.mockClear();
    await expect(
      f.runtime.moveRelays(group.group_pubkey, ['wss://failed.example/']),
    ).rejects.toThrow('No recovery relay saved');
    expect(f.publish.mock.calls.some(([, relays]) => relays.includes('wss://relay.example/'))).toBe(
      false,
    );
    expect((await f.runtime.secretFor(group.group_pubkey)).recovery_state_id).toBe(
      group.recovery_state_id,
    );
  });
  it('follows successive signed relay moves from an original seed backup', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Moved group', '', ['wss://relay.example/']);
    await f.runtime.moveRelays(group.group_pubkey, ['wss://second.example/']);
    await f.runtime.moveRelays(group.group_pubkey, ['wss://third.example/']);
    const latest = await f.runtime.update(group.group_pubkey, [f.owner.pubkey], false, true);
    const restored = await createGroupRecoveryRuntime(f.dependencies).inspect(phrase, [
      'wss://relay.example/',
    ]);
    expect(restored.heads).toHaveLength(1);
    expect(restored.heads[0].id).toBe(latest.recovery_state_id);
    expect(restored.heads[0].state.relays).toEqual(['wss://third.example/']);
    expect(restored.heads[0].state.epoch).toBe(1);
  });
  it('aborts when the account changes during secret decryption', async () => {
    const f = fixture();
    const group = await f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']);
    vi.spyOn(f.dependencies, 'decrypt').mockImplementationOnce(async (value) => {
      f.changeAccount('f'.repeat(64));
      return JSON.parse(value);
    });
    await expect(f.runtime.secretFor(group.group_pubkey)).rejects.toThrow('active account changed');
  });
  it('requires real EOSE rather than treating a deadline as an empty group history', async () => {
    const f = fixture();
    vi.useFakeTimers();
    try {
      vi.spyOn(f.dependencies.ndk, 'subscribe').mockReturnValue({
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      } as any);
      const result = expect(
        f.runtime.create(phrase, 'Group', '', ['wss://relay.example/']),
      ).rejects.toThrow('No relay completed');
      await vi.advanceTimersByTimeAsync(12001);
      await result;
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
