import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import NostrClient, {
  ClientEvent,
  giftWrap,
  giftUnwrap,
  NostrPrivateKeySigner,
  NostrUser,
} from '#src/lib/nostr/client.ts';
import {
  verifyGroupMessage,
  type GroupMessageEpoch,
} from '#src/stores/nostr/groupMessageAuthorization.ts';
import { createMessageEventRuntime } from '#src/stores/nostr/messageEventRuntime.ts';
import {
  normalizeChatGroupEpochKeysValue,
  mergeGroupEpochMetadata,
} from '#src/utils/groupEpochMetadata.ts';
import type { ChatRow } from '#src/services/chatDataService.ts';

const owner = generateSecretKey();
const member = new NostrPrivateKeySigner(generateSecretKey());
const outsider = new NostrPrivateKeySigner(generateSecretKey());
const epochSigner = new NostrPrivateKeySigner(generateSecretKey());
const epoch: GroupMessageEpoch = {
  groupPublicKey: getPublicKey(owner),
  epochNumber: 3,
  epochPublicKey: epochSigner.pubkey,
  epochPrivateKey: epochSigner.privateKey!,
};
// Sign independently with nostr-tools, rather than the code under test.
const ticket = finalizeEvent(
  {
    kind: 1014,
    created_at: 1700000000,
    content: epoch.epochPrivateKey,
    tags: [
      ['p', member.pubkey],
      ['epoch', '3'],
    ],
  },
  owner,
);
function rumor(kind = 14) {
  return new ClientEvent(undefined, {
    kind,
    pubkey: member.pubkey,
    created_at: 1700000010,
    content: 'hello',
    tags: [
      ['p', epoch.epochPublicKey],
      ['h', epoch.groupPublicKey],
      ['epoch', '3'],
      ['invited_at', String(ticket.created_at)],
      ['invitation_proof', ticket.sig],
    ],
  });
}
function setup() {
  const epochEntry = {
    epoch_number: epoch.epochNumber,
    epoch_public_key: epoch.epochPublicKey,
    epoch_private_key_encrypted: 'encrypted',
    invitation_created_at: new Date(ticket.created_at * 1000).toISOString(),
    invitation_proof: ticket.sig,
    invitation_event_id: ticket.id,
  };
  const context = {
    epochEntry,
    chat: {
      public_key: epoch.groupPublicKey,
      type: 'group',
      meta: { current_epoch_public_key: epoch.epochPublicKey, group_epoch_keys: [epochEntry] },
    } as ChatRow,
  };
  let account = member.pubkey;
  const issueOwnGroupInvitation = vi.fn<
    Parameters<typeof createMessageEventRuntime>[0]['issueOwnGroupInvitation']
  >(async () => null);
  const runtime = createMessageEventRuntime({
    issueOwnGroupInvitation,
    ndk: new NostrClient(),
    getLoggedInPublicKeyHex: () => account,
    decryptPrivateStringContent: async () => epoch.epochPrivateKey,
    derivePublicKeyFromPrivateKey: (key) => new NostrPrivateKeySigner(key).pubkey,
    findGroupChatEpochContextByRecipientPubkey: async (key) =>
      key === epoch.epochPublicKey ? context : null,
    getOrCreateSigner: async () => member,
    readEpochNumberTag: (tags) => Number(tags.find((t) => t[0] === 'epoch')?.[1]),
    readFirstTagValue: (tags, name) => tags.find((t) => t[0] === name)?.[1] ?? null,
  });
  return {
    issueOwnGroupInvitation,
    runtime,
    context,
    epochEntry,
    setAccount: (key: string) => {
      account = key;
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe('private group message authorization', () => {
  it.each([14, 15, 7, 5])('accepts a real member ticket for kind %s', async (kind) => {
    expect(await verifyGroupMessage(rumor(kind), epoch)).toBe(true);
  });
  it.each(['p', 'h', 'epoch', 'invited_at', 'invitation_proof'])(
    'rejects missing, duplicate and malformed %s',
    async (name) => {
      const original = rumor();
      const tag = original.tags.find((t) => t[0] === name)!;
      for (const tags of [
        original.tags.filter((t) => t[0] !== name),
        [...original.tags, tag],
        original.tags.map((t) => (t[0] === name ? [...t, 'extra'] : t)),
        original.tags.map((t) => (t[0] === name ? [name, 'bad'] : t)),
      ]) {
        expect(await verifyGroupMessage({ ...original, tags }, epoch)).toBe(false);
      }
    },
  );
  it('rejects a stolen proof, wrong signing key, wrong group, changed epoch key and signed rumors', async () => {
    expect(await verifyGroupMessage({ ...rumor(), pubkey: outsider.pubkey }, epoch)).toBe(
      false,
    );
    const bad = rumor();
    bad.tags[4][1] = finalizeEvent(
      {
        kind: 1014,
        created_at: ticket.created_at,
        content: epoch.epochPrivateKey,
        tags: ticket.tags,
      },
      outsider.secretKey,
    ).sig;
    expect(await verifyGroupMessage(bad, epoch)).toBe(false);
    expect(
      await verifyGroupMessage(rumor(), { ...epoch, epochPrivateKey: outsider.privateKey! }),
    ).toBe(false);
    expect(
      await verifyGroupMessage(rumor(), { ...epoch, groupPublicKey: outsider.pubkey }),
    ).toBe(false);
    expect(await verifyGroupMessage({ ...rumor(), sig: ticket.sig }, epoch)).toBe(false);
    expect(await verifyGroupMessage({ ...rumor(), pubkey: epoch.epochPublicKey }, epoch)).toBe(
      false,
    );
  });
  it.each(['03', '-1', '3x', '9007199254740992'])(
    'rejects noncanonical epoch %s',
    async (value) => {
      const event = rumor();
      event.tags[2][1] = value;
      expect(await verifyGroupMessage(event, epoch)).toBe(false);
    },
  );
  it('permits only well-formed announcements from the group identity', async () => {
    const event = new ClientEvent(undefined, {
      ...rumor().rawEvent(),
      pubkey: epoch.groupPublicKey,
      content: '+',
      tags: [...rumor().tags.slice(0, 3), ['member', member.pubkey]],
    });
    expect(await verifyGroupMessage(event, epoch)).toBe(true);
    event.content = 'ordinary owner message';
    expect(await verifyGroupMessage(event, epoch)).toBe(false);
    event.content = '+';
    event.kind = 5;
    expect(await verifyGroupMessage(event, epoch)).toBe(false);
  });
  it('adds proofs to sends and reactions and validates retries without changing the event', async () => {
    const { runtime } = setup();
    for (const event of [
      runtime.createDirectMessageRumorEvent(
        member.pubkey,
        epoch.epochPublicKey,
        'hi',
        1700000010,
      ),
      runtime.createReactionRumorEvent(
        member.pubkey,
        epoch.epochPublicKey,
        '👍',
        ticket.id,
        outsider.pubkey,
        14,
        1700000010,
      ),
      runtime.createEventDeletionRumorEvent(
        member.pubkey,
        epoch.epochPublicKey,
        ticket.id,
        14,
        1700000010,
      ),
    ]) {
      await runtime.prepareOutgoingPrivateMessage(event, epoch.epochPublicKey);
      expect(event.getMatchingTags('p')).toEqual([['p', epoch.epochPublicKey]]);
      expect(await runtime.verifyIncomingGroupMessage(event, epoch.epochPublicKey)).toBe(true);
      const before = JSON.stringify(event.rawEvent());
      await runtime.prepareOutgoingPrivateMessage(event, epoch.epochPublicKey, true);
      expect(JSON.stringify(event.rawEvent())).toBe(before);
    }
    const legacy = runtime.createDirectMessageRumorEvent(
      member.pubkey,
      epoch.epochPublicKey,
      'hi',
      1700000010,
    );
    await expect(
      runtime.prepareOutgoingPrivateMessage(legacy, epoch.epochPublicKey, true),
    ).rejects.toThrow('membership proof');
  });
  it('issues and reuses a missing owner invitation without modifying a retry', async () => {
    const { runtime, epochEntry, issueOwnGroupInvitation } = setup();
    epochEntry.invitation_proof = '';
    issueOwnGroupInvitation.mockImplementation(async () => {
      epochEntry.invitation_proof = ticket.sig;
      return { proof: ticket.sig, invitedAt: ticket.created_at };
    });
    const event = rumor();
    await runtime.prepareOutgoingPrivateMessage(event, epoch.epochPublicKey);
    expect(await verifyGroupMessage(event, epoch)).toBe(true);
    await runtime.prepareOutgoingPrivateMessage(event, epoch.epochPublicKey, true);
    await runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey);
    expect(issueOwnGroupInvitation).toHaveBeenCalledExactlyOnceWith(
      epoch.groupPublicKey,
      epoch.epochPublicKey,
    );
  });
  it('rejects an invalid issued ticket and stops if the account changes during issuance', async () => {
    const { runtime, epochEntry, issueOwnGroupInvitation, setAccount } = setup();
    epochEntry.invitation_proof = '';
    issueOwnGroupInvitation.mockResolvedValue({
      proof: 'f'.repeat(128),
      invitedAt: ticket.created_at,
    });
    await expect(
      runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey),
    ).rejects.toThrow('membership proof');
    issueOwnGroupInvitation.mockImplementation(async () => {
      setAccount(outsider.pubkey);
      return { proof: ticket.sig, invitedAt: ticket.created_at };
    });
    await expect(
      runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey),
    ).rejects.toThrow('active account changed');
  });
  it('blocks missing tickets, stale epochs, conflicts and wrong-account retries', async () => {
    const { runtime, epochEntry, context, setAccount } = setup();
    epochEntry.invitation_proof = '';
    await expect(
      runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey),
    ).rejects.toThrow('resend');
    epochEntry.invitation_proof = ticket.sig;
    context.chat.meta.group_conflicting_epoch = 3;
    await expect(
      runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey),
    ).rejects.toThrow('Refresh');
    context.chat.meta.group_conflicting_epoch = -1;
    context.chat.meta.current_epoch_public_key = outsider.pubkey;
    await expect(
      runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey),
    ).rejects.toThrow('Refresh');
    setAccount(outsider.pubkey);
    await expect(
      runtime.prepareOutgoingPrivateMessage(rumor(), epoch.epochPublicKey, true),
    ).rejects.toThrow('active account');
  });
  it('preserves proof/timestamp pairs across stale writes and reload normalization', () => {
    const { epochEntry } = setup();
    const merged = mergeGroupEpochMetadata(
      { group_epoch_keys: [epochEntry] },
      {
        group_epoch_keys: [
          {
            ...epochEntry,
            invitation_created_at: new Date((ticket.created_at + 100) * 1000).toISOString(),
            invitation_proof: undefined,
          },
        ],
      },
    );
    expect(normalizeChatGroupEpochKeysValue(merged.group_epoch_keys)).toEqual([epochEntry]);
    const tied = {
      ...epochEntry,
      invitation_event_id: '0'.repeat(64),
      invitation_proof: '1'.repeat(128),
    };
    const selected = mergeGroupEpochMetadata(merged, { group_epoch_keys: [tied] });
    expect(normalizeChatGroupEpochKeysValue(selected.group_epoch_keys)).toEqual([tied]);
  });
  it('retains the signed invitation when unwrapping a ticket, but rejects nonempty group seals', async () => {
    const { runtime } = setup();
    const signedTicket = new ClientEvent(undefined, ticket);
    const wrappedTicket = await runtime.giftWrapSignedEvent(
      signedTicket,
      new NostrUser({ pubkey: member.pubkey }),
      new NostrPrivateKeySigner(owner),
    );
    const ticketRumor = await giftUnwrap(wrappedTicket, undefined, member);
    const seal = JSON.parse(
      await member.decrypt(wrappedTicket.author, wrappedTicket.content, 'nip44'),
    );
    const verified = await runtime.verifyIncomingGroupEpochTicket(ticketRumor, seal);
    expect(verified.isValid).toBe(true);
    expect(verified.signedEvent?.sig).toBe(ticket.sig);
    ticketRumor.tags.push(['epoch', '3']);
    expect((await runtime.verifyIncomingGroupEpochTicket(ticketRumor, seal)).isValid).toBe(
      false,
    );
    const event = rumor();
    await event.sign(member);
    const badSeal = await runtime.giftWrapSignedEvent(
      event,
      new NostrUser({ pubkey: epoch.epochPublicKey }),
      member,
    );
    await expect(
      giftUnwrap(badSeal, { requireEmptySealTags: true }, epochSigner),
    ).rejects.toThrow('Invalid seal');
  });
  it('accepts valid encrypted member messages but rejects uninvited senders after real NIP-59 decryption', async () => {
    const { runtime } = setup();
    const event = rumor();
    const wrapped = await giftWrap(
      event,
      new NostrUser({ pubkey: epoch.epochPublicKey }),
      member,
    );
    const decrypted = await giftUnwrap(wrapped, { requireEmptySealTags: true }, epochSigner);
    expect(await runtime.verifyIncomingGroupMessage(decrypted, epoch.epochPublicKey)).toBe(
      true,
    );
    const forged = new ClientEvent(undefined, {
      ...event.rawEvent(),
      pubkey: outsider.pubkey,
    });
    const attack = await giftWrap(
      forged,
      new NostrUser({ pubkey: epoch.epochPublicKey }),
      outsider,
    );
    expect(
      await runtime.verifyIncomingGroupMessage(
        await giftUnwrap(attack, { requireEmptySealTags: true }, epochSigner),
        epoch.epochPublicKey,
      ),
    ).toBe(false);
  });
});
