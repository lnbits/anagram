import type { createGroupRecoveryRuntime } from './groupRecoveryRuntime.ts';
import NostrClient, {
  ClientEvent,
  NostrPrivateKeySigner,
  NostrUser,
  type NostrEvent,
} from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { GROUP_PRIVATE_KEY_CONTACT_META_KEY } from '#src/stores/nostr/constants.ts';
import type {
  GroupIdentitySecretContent,
  PublishGroupMemberChangesResult,
  RelayPublishStatusesResult,
  RelaySaveStatus,
  RotateGroupEpochResult,
} from '#src/stores/nostr/types.ts';
import {
  normalizeRelayStatusUrlsValue,
  resolveGroupPublishRelayUrlsValue,
} from '#src/stores/nostr/valueUtils.ts';
import type { MessageRelayStatus } from '#src/types/chat.ts';
import type { ContactRecord } from '#src/types/contact.ts';

interface GroupEpochPublishRuntimeDeps {
  recovery: ReturnType<typeof createGroupRecoveryRuntime>;
  appendRelayStatusesToGroupMemberTicketEvent: (
    groupPublicKey: string,
    memberPublicKey: string,
    epochNumber: number,
    relayStatuses: MessageRelayStatus[],
    options?: {
      event?: NostrEvent;
      direction?: 'in' | 'out';
      eventId?: string;
      createdAt?: string;
    },
  ) => Promise<void>;
  buildFailedOutboundRelayStatuses: (
    relayUrls: string[],
    scope: 'recipient' | 'self',
    detail: string,
  ) => MessageRelayStatus[];
  buildPendingOutboundRelayStatuses: (
    relayUrls: string[],
    scope: 'recipient' | 'self',
  ) => MessageRelayStatus[];
  buildRelaySaveStatus: (relayStatuses: MessageRelayStatus[]) => RelaySaveStatus;
  encryptGroupIdentitySecretContent: (content: GroupIdentitySecretContent) => Promise<string>;
  ensureGroupIdentitySecretEpochState: (
    groupContact: ContactRecord,
    seedRelayUrls?: string[],
  ) => Promise<{
    contact: ContactRecord;
    secret: GroupIdentitySecretContent;
  }>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  getAppRelayUrls: () => string[];
  getLoggedInPublicKeyHex: () => string | null;
  giftWrapSignedEvent: (
    signedEvent: ClientEvent,
    recipient: NostrUser,
    signer: NostrPrivateKeySigner,
  ) => Promise<ClientEvent>;
  ndk: NostrClient;
  normalizeEventId: (value: unknown) => string | null;
  persistIncomingGroupEpochTicket: (
    groupPublicKey: string,
    epochNumber: number,
    epochPrivateKey: string,
    options?: {
      fallbackName?: string;
      accepted?: boolean;
      invitationCreatedAt?: string;
      invitationProof?: string;
      invitationEventId?: string;
      seedRelayUrls?: string[];
    },
  ) => Promise<void>;
  publishEventWithRelayStatuses: (
    event: ClientEvent,
    relayUrls: string[],
    scope?: 'recipient' | 'self',
  ) => Promise<RelayPublishStatusesResult>;
  publishGroupIdentitySecret: (
    groupPublicKey: string,
    encryptedPrivateKey: string,
    seedRelayUrls?: string[],
  ) => Promise<RelaySaveStatus>;
  publishGroupMembershipFollowSet: (
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls?: string[],
  ) => Promise<RelaySaveStatus>;
  publishGroupMembershipRosterFollowSet: (
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls?: string[],
  ) => Promise<RelaySaveStatus>;
  toIsoTimestampFromUnix: (value: number | undefined) => string;
  toStoredNostrEvent: (event: ClientEvent) => Promise<NostrEvent | null>;
}

export function createGroupEpochPublishRuntime({
  recovery,
  appendRelayStatusesToGroupMemberTicketEvent,
  buildFailedOutboundRelayStatuses,
  buildPendingOutboundRelayStatuses,
  buildRelaySaveStatus,
  encryptGroupIdentitySecretContent,
  ensureGroupIdentitySecretEpochState,
  ensureRelayConnections,
  getAppRelayUrls,
  getLoggedInPublicKeyHex,
  giftWrapSignedEvent,
  ndk,
  normalizeEventId,
  persistIncomingGroupEpochTicket,
  publishEventWithRelayStatuses,
  publishGroupIdentitySecret,
  publishGroupMembershipFollowSet,
  publishGroupMembershipRosterFollowSet,
  toIsoTimestampFromUnix,
  toStoredNostrEvent,
}: GroupEpochPublishRuntimeDeps) {
  function normalizeUniqueMemberPublicKeys(
    memberPublicKeys: string[],
    excludedPublicKeys: string[] = [],
  ): string[] {
    const excludedPubkeySet = new Set(
      excludedPublicKeys
        .map((publicKey) => inputSanitizerService.normalizeHexKey(publicKey))
        .filter((publicKey): publicKey is string => Boolean(publicKey)),
    );

    return Array.from(
      new Set(
        memberPublicKeys
          .map((memberPublicKey) => inputSanitizerService.normalizeHexKey(memberPublicKey))
          .filter((memberPublicKey): memberPublicKey is string => Boolean(memberPublicKey))
          .filter((memberPublicKey) => !excludedPubkeySet.has(memberPublicKey)),
      ),
    );
  }

  async function publishRecoverableMembers(
    group: string,
    memberPublicKeys: string[],
    rotate: boolean,
    expectedStateId?: string,
  ): Promise<PublishGroupMemberChangesResult> {
    return recovery.exclusive(group, async () => {
      const account = getLoggedInPublicKeyHex();
      if (!account) throw new Error('Sign in before managing a group.');
      const secret = await recovery.secretFor(group);
      if (expectedStateId && secret.recovery_state_id !== expectedStateId)
        throw new Error(
          'Group membership changed since you opened this form. Close it and refresh members before saving again.',
        );
      const members = normalizeUniqueMemberPublicKeys(
        [...memberPublicKeys, account],
        [group],
      ).sort();
      const current = [...(secret.recovery_state?.members ?? [])].sort();
      const changed = JSON.stringify(current) !== JSON.stringify(members);
      let next = secret;
      if (changed || rotate) {
        if (
          secret.recovery_state!.owners.some(
            (owner) => current.includes(owner) && !members.includes(owner),
          )
        ) {
          throw new Error(
            'This member holds the group master. Use Replace group master in Recovery to remove an owner.',
          );
        }
        next = await recovery.update(group, members, false, rotate);
      } else await recovery.assertCurrent(group);
      const failed: string[] = [];
      const published = new Set<string>();
      // Re-send all current tickets on retry: a partial prior delivery must not be skipped.
      for (const member of members) {
        try {
          const result = await sendGroupEpochTicket(group, member, [], next.recovery_state_id);
          if (!result.publishedRelayUrls.length) failed.push(member);
          for (const relay of result.publishedRelayUrls) published.add(relay);
        } catch {
          failed.push(member);
        }
      }
      await publishGroupMembershipFollowSet(
        group,
        members.filter((p) => p !== account),
        next.recovery_state!.relays,
      );
      await publishGroupMembershipRosterFollowSet(
        group,
        members.filter((p) => p !== account),
        next.recovery_state!.relays,
      );
      return {
        epochNumber: next.epoch_number!,
        createdNewEpoch: next.epoch_number !== secret.epoch_number,
        attemptedMemberCount: members.length,
        deliveredMemberCount: members.length - failed.length,
        failedMemberPubkeys: failed,
        publishedRelayUrls: [...published],
      };
    });
  }

  async function rotateGroupEpochAndSendTickets(
    groupPublicKey: string,
    memberPublicKeys: string[],
    seedRelayUrls: string[] = [],
    expectedStateId?: string,
  ): Promise<RotateGroupEpochResult> {
    return publishRecoverableMembers(groupPublicKey, memberPublicKeys, true, expectedStateId);
  }

  async function publishGroupMemberChanges(
    groupPublicKey: string,
    memberPublicKeys: string[],
    _seedRelayUrls: string[] = [],
    expectedStateId?: string,
  ): Promise<PublishGroupMemberChangesResult> {
    return publishRecoverableMembers(groupPublicKey, memberPublicKeys, false, expectedStateId);
  }

  async function sendGroupEpochTicket(
    groupPublicKey: string,
    memberPublicKey: string,
    seedRelayUrls: string[] = [],
    expectedStateId?: string,
  ): Promise<RelaySaveStatus> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const normalizedMemberPublicKey = inputSanitizerService.normalizeHexKey(memberPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey || !normalizedMemberPublicKey) {
      throw new Error('A valid group public key and member public key are required.');
    }

    await contactsService.init();
    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? '',
    );
    if (!normalizedOwnerPublicKey || normalizedOwnerPublicKey !== loggedInPubkeyHex) {
      throw new Error('Only the owner can send epoch tickets for this group.');
    }

    const updatedGroupContact = groupContact;
    const secret = await recovery.current(normalizedGroupPublicKey, expectedStateId);
    const normalizedEpochPrivateKey = inputSanitizerService.normalizeHexKey(
      secret.epoch_privkey ?? '',
    );
    if (!normalizedEpochPrivateKey || !Number.isInteger(secret.epoch_number)) {
      throw new Error('Missing current epoch state for this group.');
    }

    if (!secret.recovery_state?.members.includes(normalizedMemberPublicKey)) {
      throw new Error('This account is not in the current group membership.');
    }
    const groupSigner = new NostrPrivateKeySigner(secret.group_privkey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedGroupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    const relayUrls = resolveGroupPublishRelayUrlsValue(updatedGroupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot send epoch ticket without at least one group relay.');
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const epochTicketEvent = new ClientEvent(ndk, {
      kind: 1014,
      created_at: createdAt,
      pubkey: normalizedGroupPublicKey,
      content: normalizedEpochPrivateKey,
      tags: [
        ['p', normalizedMemberPublicKey],
        ['epoch', String(Math.floor(Number(secret.epoch_number)))],
      ],
    });
    await epochTicketEvent.sign(groupSigner);

    if (getLoggedInPublicKeyHex() !== loggedInPubkeyHex)
      throw new Error('The active account changed.');
    if (normalizedMemberPublicKey === loggedInPubkeyHex) {
      await persistIncomingGroupEpochTicket(
        normalizedGroupPublicKey,
        Number(secret.epoch_number),
        normalizedEpochPrivateKey,
        {
          accepted: true,
          invitationCreatedAt: toIsoTimestampFromUnix(createdAt),
          invitationProof: epochTicketEvent.sig,
          invitationEventId: epochTicketEvent.id,
          seedRelayUrls: relayUrls,
        },
      );
    }
    const storedEpochTicketEvent = await toStoredNostrEvent(epochTicketEvent);
    const epochTicketEventId = normalizeEventId(storedEpochTicketEvent?.id ?? epochTicketEvent.id);
    const createdAtIso = toIsoTimestampFromUnix(createdAt);
    const epochNumber = Math.floor(Number(secret.epoch_number));

    if (epochTicketEventId && createdAtIso) {
      await appendRelayStatusesToGroupMemberTicketEvent(
        normalizedGroupPublicKey,
        normalizedMemberPublicKey,
        epochNumber,
        buildPendingOutboundRelayStatuses(relayUrls, 'recipient'),
        {
          event: storedEpochTicketEvent ?? undefined,
          direction: 'out',
          eventId: epochTicketEventId,
          createdAt: createdAtIso,
        },
      );
    }

    let publishResult: RelayPublishStatusesResult | null = null;

    try {
      await ensureRelayConnections(relayUrls);
      const recipient = new NostrUser({ pubkey: normalizedMemberPublicKey });
      const giftWrapEvent = await giftWrapSignedEvent(epochTicketEvent, recipient, groupSigner);
      publishResult = await publishEventWithRelayStatuses(giftWrapEvent, relayUrls, 'recipient');
    } catch (error) {
      const failureDetail =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to publish epoch ticket.';
      if (epochTicketEventId && createdAtIso) {
        await appendRelayStatusesToGroupMemberTicketEvent(
          normalizedGroupPublicKey,
          normalizedMemberPublicKey,
          epochNumber,
          buildFailedOutboundRelayStatuses(relayUrls, 'recipient', failureDetail),
          {
            event: storedEpochTicketEvent ?? undefined,
            direction: 'out',
            eventId: epochTicketEventId,
            createdAt: createdAtIso,
          },
        );
      }
      throw error;
    }

    if (epochTicketEventId && createdAtIso) {
      await appendRelayStatusesToGroupMemberTicketEvent(
        normalizedGroupPublicKey,
        normalizedMemberPublicKey,
        epochNumber,
        publishResult.relayStatuses,
        {
          event: storedEpochTicketEvent ?? undefined,
          direction: 'out',
          eventId: epochTicketEventId,
          createdAt: createdAtIso,
        },
      );
    }

    const relaySaveStatus = buildRelaySaveStatus(publishResult.relayStatuses);
    if (publishResult.error && !relaySaveStatus.errorMessage) {
      relaySaveStatus.errorMessage = publishResult.error.message;
    }

    if (
      publishResult.error &&
      !publishResult.relayStatuses.some(
        (entry) => entry.direction === 'outbound' && entry.status === 'published',
      )
    ) {
      throw publishResult.error;
    }

    return relaySaveStatus;
  }

  return {
    publishGroupMemberChanges,
    rotateGroupEpochAndSendTickets,
    sendGroupEpochTicket,
  };
}
