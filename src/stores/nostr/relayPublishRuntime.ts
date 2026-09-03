import NDK, {
  giftWrap,
  isValidPubkey,
  NDKEvent,
  NDKKind,
  NDKPrivateKeySigner,
  NDKRelayList,
  NDKRelaySet,
  NDKRelayStatus,
  type NDKSigner,
  NDKUser,
  type NDKUserProfile,
  type NostrEvent,
  serializeProfile,
} from '@nostr-dev-kit/ndk';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { RELAY_PUBLISH_TIMEOUT_MS } from 'src/stores/nostr/constants';
import type {
  GiftWrappedRumorPublishResult,
  GroupIdentitySecretContent,
  PublishUserMetadataInput,
  RelayListMetadataEntry,
  RelayPublishStatusesResult,
  RelaySaveStatus,
  SendGiftWrappedRumorOptions,
} from 'src/stores/nostr/types';
import type { MessageRelayStatus } from 'src/types/chat';

interface RelayPublishRuntimeDeps {
  appendRelayStatusesToMessageEvent: (
    messageId: number,
    relayStatuses: MessageRelayStatus[],
    options?: {
      uiThrottleMs?: number;
      event?: NostrEvent;
      direction?: 'in' | 'out';
      eventId?: string;
    }
  ) => Promise<void>;
  buildRelaySaveStatus: (relayStatuses: MessageRelayStatus[]) => RelaySaveStatus;
  decryptGroupIdentitySecretContent: (
    content: string
  ) => Promise<GroupIdentitySecretContent | null>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  getRelayConnectionAttemptBlockReason: (relayUrl: string) => string | null;
  getLoggedInPublicKeyHex: () => string | null;
  getOrCreateSigner: () => Promise<NDKSigner>;
  ndk: NDK;
  normalizeEventId: (value: unknown) => string | null;
  normalizeRelayStatusUrl: (value: string) => string | null;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  resolveGroupPublishRelayUrls: (
    relays: Array<{ url: string; read?: boolean; write?: boolean }> | undefined,
    seedRelayUrls?: string[]
  ) => string[];
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  toStoredNostrEvent: (event: NDKEvent) => Promise<NostrEvent | null>;
  toUnixTimestamp: (value: string | undefined) => number;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
}

export function createRelayPublishRuntime({
  appendRelayStatusesToMessageEvent,
  buildRelaySaveStatus,
  decryptGroupIdentitySecretContent,
  ensureRelayConnections,
  getRelayConnectionAttemptBlockReason,
  getLoggedInPublicKeyHex,
  getOrCreateSigner,
  ndk,
  normalizeEventId,
  normalizeRelayStatusUrl,
  normalizeRelayStatusUrls,
  resolveGroupPublishRelayUrls,
  resolveLoggedInPublishRelayUrls,
  toStoredNostrEvent,
  toUnixTimestamp,
  updateStoredEventSinceFromCreatedAt,
}: RelayPublishRuntimeDeps) {
  function buildOutboundRelayStatuses(
    relayUrls: string[],
    publishedRelayUrls: Set<string>,
    errorsByRelayUrl: Map<string, string>,
    scope: 'recipient' | 'self'
  ): MessageRelayStatus[] {
    const updatedAt = new Date().toISOString();

    return normalizeRelayStatusUrls(relayUrls).map((relayUrl) => {
      const isPublished = publishedRelayUrls.has(relayUrl);
      const detail = isPublished
        ? undefined
        : (errorsByRelayUrl.get(relayUrl) ?? 'Relay did not acknowledge publish.');

      return {
        relay_url: relayUrl,
        direction: 'outbound',
        status: isPublished ? 'published' : 'failed',
        scope,
        updated_at: updatedAt,
        ...(detail ? { detail } : {}),
      };
    });
  }

  function buildPendingOutboundRelayStatuses(
    relayUrls: string[],
    scope: 'recipient' | 'self'
  ): MessageRelayStatus[] {
    const updatedAt = new Date().toISOString();

    return normalizeRelayStatusUrls(relayUrls).map((relayUrl) => ({
      relay_url: relayUrl,
      direction: 'outbound',
      status: 'pending',
      scope,
      updated_at: updatedAt,
    }));
  }

  function buildFailedOutboundRelayStatuses(
    relayUrls: string[],
    scope: 'recipient' | 'self',
    detail: string
  ): MessageRelayStatus[] {
    const normalizedRelayUrls = normalizeRelayStatusUrls(relayUrls);
    const normalizedDetail = detail.trim() || 'Failed to publish event.';
    const errorsByRelayUrl = new Map<string, string>();

    for (const relayUrl of normalizedRelayUrls) {
      errorsByRelayUrl.set(relayUrl, normalizedDetail);
    }

    return buildOutboundRelayStatuses(
      normalizedRelayUrls,
      new Set<string>(),
      errorsByRelayUrl,
      scope
    );
  }

  function extractRelayUrlsFromEvent(event: NDKEvent): string[] {
    return normalizeRelayStatusUrls([
      event.relay?.url ?? '',
      ...event.onRelays.map((relay) => relay.url),
    ]);
  }

  async function publishSignedEventToRelays(
    event: NDKEvent,
    relayUrls: string[]
  ): Promise<{
    publishedRelayUrls: Set<string>;
    errorsByRelayUrl: Map<string, string>;
  }> {
    const publishedRelayUrls = new Set<string>();
    const errorsByRelayUrl = new Map<string, string>();
    const eligibleRelayUrls: string[] = [];
    for (const relayUrl of relayUrls) {
      const blockReason = getRelayConnectionAttemptBlockReason(relayUrl);
      if (blockReason) {
        errorsByRelayUrl.set(relayUrl, blockReason);
      } else {
        eligibleRelayUrls.push(relayUrl);
      }
    }

    const relaySet = NDKRelaySet.fromRelayUrls(eligibleRelayUrls, ndk, false);
    const relays = Array.from(relaySet.relays).filter((relay) => {
      if (relay.status >= NDKRelayStatus.CONNECTED) {
        return true;
      }

      const normalizedRelayUrl = normalizeRelayStatusUrl(relay.url);
      if (normalizedRelayUrl) {
        errorsByRelayUrl.set(normalizedRelayUrl, 'Relay is not connected.');
      }
      return false;
    });
    if (relays.length === 0) {
      return {
        publishedRelayUrls,
        errorsByRelayUrl,
      };
    }

    event.ndk = ndk;
    if (!event.sig) {
      await event.sign();
    }

    const snapshotPublishedRelayUrls = new Set<string>();
    const snapshotErrorsByRelayUrl = new Map<string, string>();

    await new Promise<void>((resolve) => {
      let finished = false;
      let remaining = relays.length;
      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;
        if (timeoutId !== null) {
          globalThis.clearTimeout(timeoutId);
          timeoutId = null;
        }
        for (const relayUrl of publishedRelayUrls) {
          snapshotPublishedRelayUrls.add(relayUrl);
        }
        for (const [relayUrl, detail] of errorsByRelayUrl) {
          if (!snapshotPublishedRelayUrls.has(relayUrl)) {
            snapshotErrorsByRelayUrl.set(relayUrl, detail);
          }
        }
        resolve();
      };

      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = globalThis.setTimeout(
        finish,
        RELAY_PUBLISH_TIMEOUT_MS
      );

      for (const relay of relays) {
        const normalizedRelayUrl = normalizeRelayStatusUrl(relay.url);
        void relay
          .publish(event, RELAY_PUBLISH_TIMEOUT_MS)
          .then((success) => {
            if (finished) {
              return;
            }

            if (success && normalizedRelayUrl) {
              publishedRelayUrls.add(normalizedRelayUrl);
              errorsByRelayUrl.delete(normalizedRelayUrl);
              return;
            }

            if (normalizedRelayUrl && !publishedRelayUrls.has(normalizedRelayUrl)) {
              errorsByRelayUrl.set(normalizedRelayUrl, 'Relay did not acknowledge publish.');
            }
          })
          .catch((error) => {
            if (finished) {
              return;
            }

            if (normalizedRelayUrl && !publishedRelayUrls.has(normalizedRelayUrl)) {
              errorsByRelayUrl.set(
                normalizedRelayUrl,
                error instanceof Error ? error.message : String(error)
              );
            }
          })
          .finally(() => {
            remaining -= 1;
            if (remaining === 0) {
              finish();
            }
          });
      }
    });

    publishedRelayUrls.clear();
    errorsByRelayUrl.clear();
    for (const relayUrl of snapshotPublishedRelayUrls) {
      publishedRelayUrls.add(relayUrl);
    }
    for (const [relayUrl, detail] of snapshotErrorsByRelayUrl) {
      errorsByRelayUrl.set(relayUrl, detail);
    }

    for (const relayUrl of relayUrls) {
      if (!publishedRelayUrls.has(relayUrl) && !errorsByRelayUrl.has(relayUrl)) {
        errorsByRelayUrl.set(relayUrl, `Publish timeout after ${RELAY_PUBLISH_TIMEOUT_MS}ms`);
      }
    }

    return {
      publishedRelayUrls,
      errorsByRelayUrl,
    };
  }

  async function publishEventWithRelayStatuses(
    event: NDKEvent,
    relayUrls: string[],
    scope: 'recipient' | 'self'
  ): Promise<RelayPublishStatusesResult> {
    const normalizedRelayUrls = normalizeRelayStatusUrls(relayUrls);
    if (normalizedRelayUrls.length === 0) {
      return {
        relayStatuses: [],
        error: null,
      };
    }

    const { publishedRelayUrls, errorsByRelayUrl } = await publishSignedEventToRelays(
      event,
      normalizedRelayUrls
    );

    return {
      relayStatuses: buildOutboundRelayStatuses(
        normalizedRelayUrls,
        publishedRelayUrls,
        errorsByRelayUrl,
        scope
      ),
      error:
        publishedRelayUrls.size > 0
          ? null
          : new Error('Not enough relays received the event (0 published, 1 required)'),
    };
  }

  async function publishReplaceableEventWithRelayStatuses(
    event: NDKEvent,
    relayUrls: string[],
    scope: 'recipient' | 'self'
  ): Promise<RelayPublishStatusesResult> {
    const normalizedRelayUrls = normalizeRelayStatusUrls(relayUrls);
    if (normalizedRelayUrls.length === 0) {
      return {
        relayStatuses: [],
        error: null,
      };
    }

    event.id = '';
    event.created_at = Math.floor(Date.now() / 1000);
    event.sig = '';

    const { publishedRelayUrls, errorsByRelayUrl } = await publishSignedEventToRelays(
      event,
      normalizedRelayUrls
    );

    return {
      relayStatuses: buildOutboundRelayStatuses(
        normalizedRelayUrls,
        publishedRelayUrls,
        errorsByRelayUrl,
        scope
      ),
      error:
        publishedRelayUrls.size > 0
          ? null
          : new Error('Not enough relays received the event (0 published, 1 required)'),
    };
  }

  async function sendGiftWrappedRumor(
    recipientPublicKey: string,
    relays: string[],
    rumorKind: number,
    createRumorEvent: (
      senderPubkey: string,
      recipientPubkey: string,
      createdAt: number
    ) => NDKEvent,
    options: SendGiftWrappedRumorOptions = {}
  ): Promise<GiftWrappedRumorPublishResult> {
    const recipientInput = recipientPublicKey.trim();
    if (!recipientInput) {
      throw new Error('Recipient public key is required.');
    }

    let normalizedRecipientPubkey: string | null = null;
    if (isValidPubkey(recipientInput)) {
      normalizedRecipientPubkey = recipientInput.toLowerCase();
    } else {
      normalizedRecipientPubkey =
        inputSanitizerService.validateNpub(recipientInput).normalizedPubkey;
    }

    if (!normalizedRecipientPubkey) {
      throw new Error('Recipient public key must be a valid hex pubkey or npub.');
    }

    const relayUrls = inputSanitizerService.normalizeStringArray(relays);
    if (relayUrls.length === 0) {
      throw new Error('Cannot send encrypted event without contact relays.');
    }
    await ensureRelayConnections(relayUrls);

    const signer = await getOrCreateSigner();
    const shouldPublishSelfCopy = options.publishSelfCopy !== false;
    const createdAt = toUnixTimestamp(options.createdAt);
    const recipient = new NDKUser({ pubkey: normalizedRecipientPubkey });
    const recipientRumorEvent = createRumorEvent(
      signer.pubkey,
      normalizedRecipientPubkey,
      createdAt
    );
    const recipientRumorNostrEvent = await toStoredNostrEvent(recipientRumorEvent);
    const rumorEventId = normalizeEventId(recipientRumorNostrEvent?.id ?? recipientRumorEvent.id);
    const selfRelayUrls = shouldPublishSelfCopy ? await resolveLoggedInPublishRelayUrls() : [];
    const persistOutboundRelayStatuses = async (
      relayStatuses: MessageRelayStatus[]
    ): Promise<void> => {
      if (!options.localMessageId || !rumorEventId || relayStatuses.length === 0) {
        return;
      }

      await appendRelayStatusesToMessageEvent(options.localMessageId, relayStatuses, {
        event: recipientRumorNostrEvent ?? undefined,
        direction: 'out',
        eventId: rumorEventId,
      });
    };
    const appendFailedOutboundRelayStatuses = async (
      relayUrlsToFail: string[],
      scope: 'recipient' | 'self',
      detail: string
    ): Promise<MessageRelayStatus[]> => {
      const failedRelayStatuses = buildFailedOutboundRelayStatuses(relayUrlsToFail, scope, detail);
      await persistOutboundRelayStatuses(failedRelayStatuses);
      return failedRelayStatuses;
    };
    let recipientRelayStatusesFinalized = false;
    let selfRelayStatusesFinalized = selfRelayUrls.length === 0;

    if (options.localMessageId && rumorEventId) {
      try {
        await persistOutboundRelayStatuses([
          ...buildPendingOutboundRelayStatuses(relayUrls, 'recipient'),
          ...buildPendingOutboundRelayStatuses(selfRelayUrls, 'self'),
        ]);
      } catch (error) {
        console.warn('Failed to persist encrypted event details before publish', error);
      }
    }

    const combinedRelayStatuses: MessageRelayStatus[] = [];

    try {
      const recipientGiftWrapEvent = await giftWrap(recipientRumorEvent, recipient, signer, {
        rumorKind,
      });
      const recipientPublishResult = await publishEventWithRelayStatuses(
        recipientGiftWrapEvent,
        relayUrls,
        'recipient'
      );
      combinedRelayStatuses.push(...recipientPublishResult.relayStatuses);
      await persistOutboundRelayStatuses(recipientPublishResult.relayStatuses);
      recipientRelayStatusesFinalized = true;

      if (recipientPublishResult.error) {
        const skippedSelfRelayStatuses = await appendFailedOutboundRelayStatuses(
          selfRelayUrls,
          'self',
          'Skipped because recipient relay publish failed.'
        );
        combinedRelayStatuses.push(...skippedSelfRelayStatuses);
        selfRelayStatusesFinalized = true;
        throw recipientPublishResult.error;
      }

      if (selfRelayUrls.length > 0) {
        try {
          await ensureRelayConnections(selfRelayUrls);
          const senderRecipient = new NDKUser({ pubkey: signer.pubkey });
          const selfRumorEvent = createRumorEvent(
            signer.pubkey,
            normalizedRecipientPubkey,
            createdAt
          );
          const selfGiftWrapEvent = await giftWrap(selfRumorEvent, senderRecipient, signer, {
            rumorKind,
          });
          const selfPublishResult = await publishEventWithRelayStatuses(
            selfGiftWrapEvent,
            selfRelayUrls,
            'self'
          );
          combinedRelayStatuses.push(...selfPublishResult.relayStatuses);
          await persistOutboundRelayStatuses(selfPublishResult.relayStatuses);
          selfRelayStatusesFinalized = true;

          if (selfPublishResult.error) {
            console.warn('Failed to publish encrypted event self-copy', selfPublishResult.error);
          }
        } catch (error) {
          const selfFailureDetail =
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : 'Failed to publish encrypted event self-copy.';
          const selfFailureRelayStatuses = await appendFailedOutboundRelayStatuses(
            selfRelayUrls,
            'self',
            selfFailureDetail
          );
          combinedRelayStatuses.push(...selfFailureRelayStatuses);
          selfRelayStatusesFinalized = true;
          console.warn('Failed to publish encrypted event self-copy', error);
        }
      }

      return {
        giftWrapEvent: await recipientGiftWrapEvent.toNostrEvent(),
        rumorEvent: recipientRumorNostrEvent,
        rumorEventId,
        relayStatuses: combinedRelayStatuses,
      };
    } catch (error) {
      const failureDetail =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to publish encrypted event.';
      if (!recipientRelayStatusesFinalized) {
        await appendFailedOutboundRelayStatuses(relayUrls, 'recipient', failureDetail);
      }
      if (!selfRelayStatusesFinalized) {
        await appendFailedOutboundRelayStatuses(selfRelayUrls, 'self', failureDetail);
      }
      throw error;
    }
  }

  async function publishUserMetadata(
    metadata: PublishUserMetadataInput,
    relayUrls: string[]
  ): Promise<void> {
    const relayList = inputSanitizerService.normalizeStringArray(relayUrls);
    if (relayList.length === 0) {
      throw new Error('Cannot publish profile without at least one relay.');
    }

    await ensureRelayConnections(relayList);

    const signer = await getOrCreateSigner();
    const profileEvent = new NDKEvent(ndk, {
      content: serializeProfile(metadata as NDKUserProfile),
      created_at: Math.floor(Date.now() / 1000),
      kind: NDKKind.Metadata,
      pubkey: signer.pubkey,
      tags: [],
    });
    await profileEvent.sign(signer);
    const publishResult = await publishEventWithRelayStatuses(profileEvent, relayList, 'self');
    if (publishResult.error) {
      throw publishResult.error;
    }
  }

  async function publishGroupMetadata(
    groupPublicKey: string,
    metadata: PublishUserMetadataInput,
    seedRelayUrls: string[] = []
  ): Promise<void> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await contactsService.init();
    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? ''
    );
    if (!normalizedOwnerPublicKey || normalizedOwnerPublicKey !== loggedInPubkeyHex) {
      throw new Error('Only the owner can publish this group profile.');
    }

    const encryptedGroupPrivateKey = groupContact.meta.group_private_key_encrypted?.trim() ?? '';
    if (!encryptedGroupPrivateKey) {
      throw new Error('Encrypted group private key not found.');
    }

    const decryptedSecret = await decryptGroupIdentitySecretContent(encryptedGroupPrivateKey);
    if (
      !decryptedSecret ||
      inputSanitizerService.normalizeHexKey(decryptedSecret.group_pubkey) !==
        normalizedGroupPublicKey
    ) {
      throw new Error('Failed to decrypt the group private key.');
    }

    const relayUrls = resolveGroupPublishRelayUrls(groupContact.relays, seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish group profile without at least one group relay.');
    }

    await ensureRelayConnections(relayUrls);

    const groupSigner = new NDKPrivateKeySigner(decryptedSecret.group_privkey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedGroupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    const metadataEvent = new NDKEvent(ndk, {
      kind: NDKKind.Metadata,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify(metadata),
    } as NostrEvent);
    await metadataEvent.sign(groupSigner);

    const publishResult = await publishEventWithRelayStatuses(metadataEvent, relayUrls, 'self');
    if (
      publishResult.relayStatuses.some(
        (entry) => entry.direction === 'outbound' && entry.status === 'published'
      )
    ) {
      updateStoredEventSinceFromCreatedAt(metadataEvent.created_at);
      return;
    }

    throw publishResult.error ?? new Error('Failed to publish group profile metadata.');
  }

  async function publishGroupRelayList(
    groupPublicKey: string,
    relayEntries: RelayListMetadataEntry[],
    publishRelayUrls: string[] = []
  ): Promise<RelaySaveStatus> {
    const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(groupPublicKey);
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    if (!normalizedGroupPublicKey) {
      throw new Error('A valid group public key is required.');
    }

    await contactsService.init();
    const groupContact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found.');
    }

    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? ''
    );
    if (!normalizedOwnerPublicKey || normalizedOwnerPublicKey !== loggedInPubkeyHex) {
      throw new Error('Only the owner can publish the group relay list.');
    }

    const encryptedGroupPrivateKey = groupContact.meta.group_private_key_encrypted?.trim() ?? '';
    if (!encryptedGroupPrivateKey) {
      throw new Error('Encrypted group private key not found.');
    }

    const decryptedSecret = await decryptGroupIdentitySecretContent(encryptedGroupPrivateKey);
    if (
      !decryptedSecret ||
      inputSanitizerService.normalizeHexKey(decryptedSecret.group_pubkey) !==
        normalizedGroupPublicKey
    ) {
      throw new Error('Failed to decrypt the group private key.');
    }

    const normalizedRelayEntries =
      inputSanitizerService.normalizeRelayListMetadataEntries(relayEntries);
    const relayUrls = normalizeRelayStatusUrls([
      ...inputSanitizerService.normalizeStringArray(publishRelayUrls),
      ...normalizedRelayEntries.map((relay) => relay.url),
    ]);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish group relay list without at least one group relay.');
    }

    await ensureRelayConnections(relayUrls);

    const groupSigner = new NDKPrivateKeySigner(decryptedSecret.group_privkey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== normalizedGroupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    const relayListEvent = new NDKRelayList(ndk);
    relayListEvent.pubkey = normalizedGroupPublicKey;
    relayListEvent.created_at = Math.floor(Date.now() / 1000);
    relayListEvent.content = '';
    relayListEvent.tags = [];
    relayListEvent.bothRelayUrls = normalizedRelayEntries
      .filter((relay) => relay.read && relay.write)
      .map((relay) => relay.url);
    relayListEvent.readRelayUrls = normalizedRelayEntries
      .filter((relay) => relay.read && !relay.write)
      .map((relay) => relay.url);
    relayListEvent.writeRelayUrls = normalizedRelayEntries
      .filter((relay) => !relay.read && relay.write)
      .map((relay) => relay.url);
    await relayListEvent.sign(groupSigner);

    const publishResult = await publishEventWithRelayStatuses(relayListEvent, relayUrls, 'self');
    const relaySaveStatus = buildRelaySaveStatus(publishResult.relayStatuses);
    if (publishResult.error && !relaySaveStatus.errorMessage) {
      relaySaveStatus.errorMessage = publishResult.error.message;
    }

    if (relaySaveStatus.publishedRelayUrls.length > 0) {
      updateStoredEventSinceFromCreatedAt(relayListEvent.created_at);
    }

    return relaySaveStatus;
  }

  return {
    buildFailedOutboundRelayStatuses,
    buildPendingOutboundRelayStatuses,
    extractRelayUrlsFromEvent,
    publishEventWithRelayStatuses,
    publishGroupMetadata,
    publishGroupRelayList,
    publishReplaceableEventWithRelayStatuses,
    publishUserMetadata,
    sendGiftWrappedRumor,
  };
}
