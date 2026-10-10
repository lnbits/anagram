import { afterEach, describe, expect, it, vi } from 'vitest';
import NostrClient, { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { createGroupEpochPublishRuntime } from '#src/stores/nostr/groupEpochPublishRuntime.ts';

afterEach(() => vi.restoreAllMocks());
function setup() {
  const group = NostrPrivateKeySigner.generate(),
    owner = NostrPrivateKeySigner.generate(),
    member = NostrPrivateKeySigner.generate();
  const secret = {
    version: 2,
    group_pubkey: group.pubkey,
    group_privkey: group.privateKey,
    epoch_number: 1,
    epoch_privkey: NostrPrivateKeySigner.generate().privateKey,
    recovery_state: {
      members: [owner.pubkey, member.pubkey],
      owners: [owner.pubkey],
      relays: ['wss://relay.example/'],
    },
  };
  const contact = {
    id: 1,
    public_key: group.pubkey,
    type: 'group' as const,
    name: 'Group',
    given_name: null,
    meta: { owner_public_key: owner.pubkey, group_private_key_encrypted: 'encrypted' },
    relays: [{ url: 'wss://relay.example/', read: true, write: true }],
    sendMessagesToAppRelays: false,
  };
  vi.spyOn(contactsService, 'init').mockResolvedValue();
  vi.spyOn(contactsService, 'getContactByPublicKey').mockResolvedValue(contact);
  const recovery = {
    exclusive: async (_key: string, action: () => Promise<unknown>) => action(),
    secretFor: vi.fn(async () => secret),
    current: vi.fn(async () => secret),
    update: vi.fn(async () => secret),
    assertCurrent: vi.fn(async () => {}),
  };
  const deps = {
    ndk: new NostrClient(),
    recovery,
    persistIncomingGroupEpochTicket: vi.fn(async () => {}),
    getLoggedInPublicKeyHex: () => owner.pubkey,
    ensureGroupIdentitySecretEpochState: async () => ({ contact, secret }),
    giftWrapSignedEvent: vi.fn(async (event: any) => event),
    ensureRelayConnections: vi.fn(async () => {}),
    publishEventWithRelayStatuses: vi.fn(async () => ({ relayStatuses: [], error: null })),
    buildRelaySaveStatus: () => ({
      relayUrls: [],
      publishedRelayUrls: [],
      failedRelayUrls: [],
      errorMessage: null,
    }),
    appendRelayStatusesToGroupMemberTicketEvent: vi.fn(async () => {}),
    buildPendingOutboundRelayStatuses: () => [],
    buildFailedOutboundRelayStatuses: () => [],
    normalizeEventId: (id: string) => id,
    toStoredNostrEvent: async (e: any) => e.rawEvent(),
    toIsoTimestampFromUnix: (n: number) => new Date(n * 1000).toISOString(),
    publishGroupMembershipFollowSet: vi.fn(),
    publishGroupMembershipRosterFollowSet: vi.fn(),
  };
  return {
    group,
    owner,
    member,
    secret,
    recovery,
    deps,
    runtime: createGroupEpochPublishRuntime(deps as any),
  };
}
describe('recoverable group membership publication', () => {
  it('resends an existing member ticket without rotating the epoch or rewriting membership', async () => {
    const f = setup();
    const before = JSON.stringify(f.secret);
    await f.runtime.sendGroupEpochTicket(f.group.pubkey, f.member.pubkey);
    const ticket = f.deps.giftWrapSignedEvent.mock.calls[0][0];
    expect(ticket.verifySignature()).toBe(true);
    expect(ticket.tags).toEqual([
      ['p', f.member.pubkey],
      ['epoch', String(f.secret.epoch_number)],
    ]);
    expect(ticket.content).toBe(f.secret.epoch_privkey);
    expect(JSON.stringify(f.secret)).toBe(before);
    expect(f.recovery.update).not.toHaveBeenCalled();
    expect(f.deps.publishGroupMembershipFollowSet).not.toHaveBeenCalled();
  });
  it('does not distribute keys or overwrite membership when recovery state cannot be committed', async () => {
    const f = setup();
    f.recovery.update.mockRejectedValue(new Error('Recovery relay unavailable'));
    await expect(
      f.runtime.rotateGroupEpochAndSendTickets(f.group.pubkey, [f.member.pubkey]),
    ).rejects.toThrow('Recovery relay unavailable');
    expect(f.deps.publishEventWithRelayStatuses).not.toHaveBeenCalled();
    expect(f.deps.publishGroupMembershipFollowSet).not.toHaveBeenCalled();
  });
  it('rejects a stale membership form even if background state has advanced', async () => {
    const f = setup();
    await expect(
      f.runtime.publishGroupMemberChanges(
        f.group.pubkey,
        [f.member.pubkey],
        [],
        'old-reviewed-revision',
      ),
    ).rejects.toThrow('since you opened this form');
    expect(f.recovery.update).not.toHaveBeenCalled();
    expect(f.deps.giftWrapSignedEvent).not.toHaveBeenCalled();
  });
  it('requires current state even for resending an existing invitation', async () => {
    const f = setup();
    f.recovery.current.mockRejectedValue(new Error('Another owner changed the group'));
    await expect(f.runtime.sendGroupEpochTicket(f.group.pubkey, f.member.pubkey)).rejects.toThrow(
      'Another owner',
    );
    expect(f.deps.giftWrapSignedEvent).not.toHaveBeenCalled();
  });
  it('does not issue a ticket to a removed account', async () => {
    const f = setup();
    f.secret.recovery_state.members = [f.owner.pubkey];
    await expect(f.runtime.sendGroupEpochTicket(f.group.pubkey, f.member.pubkey)).rejects.toThrow(
      'not in the current',
    );
    expect(f.deps.publishEventWithRelayStatuses).not.toHaveBeenCalled();
  });
  it('requires master replacement to remove a known co-owner', async () => {
    const f = setup();
    f.secret.recovery_state.owners.push(f.member.pubkey);
    await expect(f.runtime.publishGroupMemberChanges(f.group.pubkey, [])).rejects.toThrow(
      'Replace group master',
    );
    expect(f.recovery.update).not.toHaveBeenCalled();
  });
  it('reports unacknowledged ticket deliveries instead of treating them as success', async () => {
    const f = setup();
    const result = await f.runtime.publishGroupMemberChanges(f.group.pubkey, [f.member.pubkey]);
    expect(result.deliveredMemberCount).toBe(0);
    expect(new Set(result.failedMemberPubkeys)).toEqual(new Set([f.owner.pubkey, f.member.pubkey]));
  });
});
