import NDK, {
  giftWrap,
  isValidNip05,
  isValidPubkey,
  NDKEvent,
  NDKKind,
  NDKPrivateKeySigner,
  type NDKSigner,
  NDKUser,
  type NostrEvent,
} from '@nostr-dev-kit/ndk';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import {
  inputSanitizerService,
  type NpubValidationResult,
  type NsecValidationResult,
  type PrivateKeyValidationResult,
} from 'src/services/inputSanitizerService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import { getOrCreateOutboundGiftWrap } from 'src/stores/nostr/outboundGiftWrap';
import type {
  GiftWrappedRumorPublishResult,
  NostrIdentifierResolutionResult,
  NostrNip05DataResult,
  SendDirectMessageDeletionOptions,
  SendDirectMessageOptions,
  SendDirectMessageReactionOptions,
} from 'src/stores/nostr/types';
import type { MessageRelayStatus } from 'src/types/chat';

interface UserActionsDeps {
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
    }
  ) => Promise<void>;
  appendRelayStatusesToMessageEvent: (
    messageId: number,
    relayStatuses: MessageRelayStatus[],
    options?: {
      event?: NostrEvent;
      direction?: 'in' | 'out';
      eventId?: string;
    }
  ) => Promise<void>;
  buildFailedOutboundRelayStatuses: (
    relayUrls: string[],
    scope: 'recipient' | 'self',
    detail: string
  ) => MessageRelayStatus[];
  buildPendingOutboundRelayStatuses: (
    relayUrls: string[],
    scope: 'recipient' | 'self'
  ) => MessageRelayStatus[];
  createDirectMessageRumorEvent: (
    senderPubkey: string,
    recipientPubkey: string,
    message: string,
    createdAt?: number,
    replyToEventId?: string | null,
    additionalTags?: string[][]
  ) => NDKEvent;
  createEventDeletionRumorEvent: (
    senderPubkey: string,
    recipientPubkey: string,
    targetEventId: string,
    targetKind: number,
    createdAt?: number
  ) => NDKEvent;
  createReactionRumorEvent: (
    senderPubkey: string,
    recipientPubkey: string,
    emoji: string,
    targetEventId: string,
    targetAuthorPublicKey: string,
    targetKind: number,
    createdAt?: number
  ) => NDKEvent;
  createStoredDirectMessageRumorEvent: (event: NostrEvent) => NDKEvent | null;
  createStoredSignedEvent: (event: NostrEvent) => NDKEvent | null;
  ensureGroupIdentitySecretEpochState: (
    groupContact: Awaited<ReturnType<typeof contactsService.getContactByPublicKey>>,
    seedRelayUrls?: string[]
  ) => Promise<{ secret: { group_privkey: string } }>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  getLoggedInPublicKeyHex: () => string | null;
  getOrCreateSigner: () => Promise<NDKSigner & { pubkey: string }>;
  giftWrapSignedEvent: (
    signedEvent: NDKEvent,
    recipient: NDKUser,
    signer: NDKSigner
  ) => Promise<NDKEvent>;
  ndk: NDK;
  normalizeEventId: (value: unknown) => string | null;
  normalizeRelayStatusUrl: (value: string) => string | null;
  logMessageRelayDiagnostics: (
    phase: string,
    details: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error'
  ) => void;
  pendingDirectMessageRelayRetryPromises: Map<string, Promise<void>>;
  publishEventWithRelayStatuses: (
    event: { kind: number },
    relayUrls: string[],
    scope?: 'recipient' | 'self'
  ) => Promise<{ relayStatuses: MessageRelayStatus[]; error: Error | null }>;
  readDirectMessageRecipientPubkey: (event: NostrEvent) => string | null;
  readEpochNumberTag: (tags: string[][]) => number | null;
  readFirstTagValue: (tags: string[][], tagName: string) => string | null;
  savePrivateKeyHex: (hexPrivateKey: string) => Promise<boolean>;
  sendGiftWrappedRumor: (
    recipientPublicKey: string,
    relays: string[],
    rumorKind: number,
    rumorFactory: (
      senderPubkey: string,
      normalizedRecipientPubkey: string,
      createdAt?: number
    ) => NDKEvent,
    options?: {
      localMessageId?: number;
      createdAt?: string;
      publishSelfCopy?: boolean;
    }
  ) => Promise<GiftWrappedRumorPublishResult>;
  toIsoTimestampFromUnix: (value: number | undefined) => string;
}

interface RetryDirectMessageRelayOptions {
  trigger?: string;
}

export function createUserActions({
  appendRelayStatusesToGroupMemberTicketEvent,
  appendRelayStatusesToMessageEvent,
  buildFailedOutboundRelayStatuses,
  buildPendingOutboundRelayStatuses,
  createDirectMessageRumorEvent,
  createEventDeletionRumorEvent,
  createReactionRumorEvent,
  createStoredDirectMessageRumorEvent,
  createStoredSignedEvent,
  ensureGroupIdentitySecretEpochState,
  ensureRelayConnections,
  getLoggedInPublicKeyHex,
  getOrCreateSigner,
  giftWrapSignedEvent,
  ndk,
  normalizeEventId,
  normalizeRelayStatusUrl,
  logMessageRelayDiagnostics,
  pendingDirectMessageRelayRetryPromises,
  publishEventWithRelayStatuses,
  readDirectMessageRecipientPubkey,
  readEpochNumberTag,
  readFirstTagValue,
  savePrivateKeyHex,
  sendGiftWrappedRumor,
  toIsoTimestampFromUnix,
}: UserActionsDeps) {
  function validateNsec(input: string): NsecValidationResult {
    return inputSanitizerService.validateNsec(input);
  }

  function validatePrivateKey(input: string): PrivateKeyValidationResult {
    return inputSanitizerService.validatePrivateKey(input);
  }

  async function savePrivateKeyFromNsec(input: string): Promise<NsecValidationResult> {
    const validation = validateNsec(input);
    if (!validation.isValid || !validation.hexPrivateKey) {
      return validation;
    }

    await savePrivateKeyHex(validation.hexPrivateKey);
    return validation;
  }

  async function savePrivateKey(input: string): Promise<PrivateKeyValidationResult> {
    const validation = validatePrivateKey(input);
    if (!validation.isValid || !validation.hexPrivateKey) {
      return validation;
    }

    await savePrivateKeyHex(validation.hexPrivateKey);
    return validation;
  }

  function validateNpub(input: string): NpubValidationResult {
    return inputSanitizerService.validateNpub(input);
  }

  async function getNip05Data(identifier: string): Promise<NostrNip05DataResult> {
    const value = identifier.trim();
    if (!value || !isValidNip05(value)) {
      return {
        isValid: false,
        normalizedPubkey: null,
        name: null,
        relays: [],
        error: 'invalid',
      };
    }

    try {
      const user = await NDKUser.fromNip05(value, ndk, true);
      const normalizedPubkey = user?.pubkey?.toLowerCase() ?? null;

      if (!normalizedPubkey || !isValidPubkey(normalizedPubkey)) {
        return {
          isValid: false,
          normalizedPubkey: null,
          name: null,
          relays: [],
          error: 'nip05_unresolved',
        };
      }

      const relays = inputSanitizerService.normalizeStringArray(user?.relayUrls ?? []);

      return {
        isValid: true,
        normalizedPubkey,
        name: user?.profile?.name?.trim() || inputSanitizerService.extractNip05Name(value),
        relays,
        error: null,
      };
    } catch {
      return {
        isValid: false,
        normalizedPubkey: null,
        name: null,
        relays: [],
        error: 'nip05_unresolved',
      };
    }
  }

  async function resolveIdentifier(input: string): Promise<NostrIdentifierResolutionResult> {
    const value = input.trim();
    if (!value) {
      return {
        isValid: false,
        normalizedPubkey: null,
        resolvedName: null,
        relays: [],
        identifierType: null,
        error: 'invalid',
      };
    }

    if (value.includes('@')) {
      const nip05Data = await getNip05Data(value);
      return {
        isValid: nip05Data.isValid,
        normalizedPubkey: nip05Data.normalizedPubkey,
        resolvedName: nip05Data.name,
        relays: nip05Data.relays,
        identifierType: 'nip05',
        error: nip05Data.error,
      };
    }

    if (isValidPubkey(value)) {
      return {
        isValid: true,
        normalizedPubkey: value.toLowerCase(),
        resolvedName: null,
        relays: [],
        identifierType: 'pubkey',
        error: null,
      };
    }

    const npubValidation = validateNpub(value);
    return {
      isValid: npubValidation.isValid,
      normalizedPubkey: npubValidation.normalizedPubkey,
      resolvedName: null,
      relays: [],
      identifierType: 'pubkey',
      error: npubValidation.isValid ? null : 'invalid',
    };
  }

  async function sendDirectMessage(
    recipientPublicKey: string,
    textMessage: string,
    relays: string[],
    options: SendDirectMessageOptions = {}
  ): Promise<NostrEvent> {
    const message = textMessage.trim();
    if (!message) {
      throw new Error('Message cannot be empty.');
    }

    const replyTargetEventId = normalizeEventId(options.replyToEventId);

    const publishResult = await sendGiftWrappedRumor(
      recipientPublicKey,
      relays,
      NDKKind.PrivateDirectMessage,
      (senderPubkey, normalizedRecipientPubkey, createdAt) => {
        return createDirectMessageRumorEvent(
          senderPubkey,
          normalizedRecipientPubkey,
          message,
          createdAt,
          replyTargetEventId,
          options.additionalTags
        );
      },
      options
    );
    return publishResult.giftWrapEvent;
  }

  async function sendDirectMessageReaction(
    recipientPublicKey: string,
    emoji: string,
    targetEventId: string,
    targetAuthorPublicKey: string,
    relays: string[],
    options: SendDirectMessageReactionOptions = {}
  ): Promise<NostrEvent | null> {
    const normalizedEmoji = emoji.trim();
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    const normalizedTargetAuthorPublicKey =
      inputSanitizerService.normalizeHexKey(targetAuthorPublicKey);
    if (!normalizedEmoji) {
      throw new Error('Reaction emoji is required.');
    }

    if (!normalizedTargetEventId) {
      throw new Error('Reaction target event id is required.');
    }

    if (!normalizedTargetAuthorPublicKey) {
      throw new Error('Reaction target author public key is required.');
    }

    const targetKind =
      Number.isInteger(options.targetKind) && Number(options.targetKind) > 0
        ? Number(options.targetKind)
        : NDKKind.PrivateDirectMessage;

    const publishResult = await sendGiftWrappedRumor(
      recipientPublicKey,
      relays,
      NDKKind.Reaction,
      (senderPubkey, normalizedRecipientPubkey, createdAt) => {
        return createReactionRumorEvent(
          senderPubkey,
          normalizedRecipientPubkey,
          normalizedEmoji,
          normalizedTargetEventId,
          normalizedTargetAuthorPublicKey,
          targetKind,
          createdAt
        );
      },
      {
        createdAt: options.createdAt,
        publishSelfCopy: options.publishSelfCopy,
      }
    );
    if (publishResult.rumorEvent) {
      await nostrEventDataService.upsertEvent({
        event: publishResult.rumorEvent,
        direction: 'out',
        relay_statuses: publishResult.relayStatuses,
      });
    }

    return publishResult.rumorEvent;
  }

  async function sendDirectMessageDeletion(
    recipientPublicKey: string,
    targetEventId: string,
    targetKind: number,
    relays: string[],
    options: SendDirectMessageDeletionOptions = {}
  ): Promise<NostrEvent | null> {
    const normalizedTargetEventId = normalizeEventId(targetEventId);
    if (!normalizedTargetEventId) {
      throw new Error('Deletion target event id is required.');
    }

    if (!Number.isInteger(targetKind) || Number(targetKind) <= 0) {
      throw new Error('Deletion target kind is required.');
    }

    const publishResult = await sendGiftWrappedRumor(
      recipientPublicKey,
      relays,
      NDKKind.EventDeletion,
      (senderPubkey, normalizedRecipientPubkey, createdAt) => {
        return createEventDeletionRumorEvent(
          senderPubkey,
          normalizedRecipientPubkey,
          normalizedTargetEventId,
          Number(targetKind),
          createdAt
        );
      },
      {
        createdAt: options.createdAt,
        publishSelfCopy: options.publishSelfCopy,
      }
    );

    return publishResult.rumorEvent;
  }

  async function retryDirectMessageRelay(
    messageId: number,
    relayUrl: string,
    scope: 'recipient' | 'self',
    options: RetryDirectMessageRelayOptions = {}
  ): Promise<void> {
    const normalizedMessageId = Number(messageId);
    const normalizedRelayUrl = normalizeRelayStatusUrl(relayUrl);
    const trigger = options.trigger?.trim() || 'manual';
    if (
      !Number.isInteger(normalizedMessageId) ||
      normalizedMessageId <= 0 ||
      !normalizedRelayUrl ||
      (scope !== 'recipient' && scope !== 'self')
    ) {
      throw new Error('Invalid relay retry input.');
    }

    const retryKey = `${normalizedMessageId}|${scope}|${normalizedRelayUrl}`;
    const existingRetryPromise = pendingDirectMessageRelayRetryPromises.get(retryKey);
    if (existingRetryPromise) {
      logMessageRelayDiagnostics('retry-join-existing', {
        messageId: normalizedMessageId,
        relayUrl: normalizedRelayUrl,
        scope,
        trigger,
      });
      return existingRetryPromise;
    }

    const retryPromise = (async () => {
      await Promise.all([chatDataService.init(), nostrEventDataService.init()]);

      const message = await chatDataService.getMessageById(normalizedMessageId);
      if (!message?.event_id) {
        throw new Error('Message is missing a persisted event id.');
      }

      const storedEvent = await nostrEventDataService.getEventById(message.event_id);
      if (!storedEvent || storedEvent.direction !== 'out') {
        throw new Error('No outbound nostr event found for this message.');
      }

      const rumorEvent = createStoredDirectMessageRumorEvent(storedEvent.event);
      if (!rumorEvent) {
        throw new Error('Failed to rebuild the direct message event for retry.');
      }

      const signer = await getOrCreateSigner();
      const recipientPubkey = readDirectMessageRecipientPubkey(storedEvent.event);
      if (!recipientPubkey) {
        throw new Error('Stored direct message event is missing a recipient.');
      }

      logMessageRelayDiagnostics('retry-start', {
        messageId: normalizedMessageId,
        eventId: message.event_id,
        relayUrl: normalizedRelayUrl,
        scope,
        trigger,
      });

      await appendRelayStatusesToMessageEvent(
        normalizedMessageId,
        buildPendingOutboundRelayStatuses([normalizedRelayUrl], scope),
        {
          event: storedEvent.event,
          direction: 'out',
          eventId: message.event_id,
        }
      );

      try {
        await ensureRelayConnections([normalizedRelayUrl]);
        const recipient =
          scope === 'self'
            ? new NDKUser({ pubkey: signer.pubkey })
            : new NDKUser({ pubkey: recipientPubkey });
        const giftWrapEvent = new NDKEvent(
          ndk,
          await getOrCreateOutboundGiftWrap(storedEvent.event, scope, () =>
            giftWrap(rumorEvent, recipient, signer as any, {
              rumorKind: NDKKind.PrivateDirectMessage,
            })
          )
        );
        const publishResult = await publishEventWithRelayStatuses(
          giftWrapEvent as { kind: number },
          [normalizedRelayUrl],
          scope
        );

        await appendRelayStatusesToMessageEvent(normalizedMessageId, publishResult.relayStatuses, {
          event: storedEvent.event,
          direction: 'out',
          eventId: message.event_id,
        });

        if (publishResult.error) {
          const failedRelayStatus = publishResult.relayStatuses.find(
            (relayStatus) =>
              relayStatus.relay_url === normalizedRelayUrl && relayStatus.status === 'failed'
          );
          const detail = failedRelayStatus?.detail?.trim();
          if (detail) {
            throw new Error(detail);
          }

          throw publishResult.error;
        }

        logMessageRelayDiagnostics('retry-success', {
          messageId: normalizedMessageId,
          eventId: message.event_id,
          relayUrl: normalizedRelayUrl,
          scope,
          trigger,
        });
      } catch (error) {
        const retryFailureDetail =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'Failed to publish event.';

        await appendRelayStatusesToMessageEvent(
          normalizedMessageId,
          buildFailedOutboundRelayStatuses([normalizedRelayUrl], scope, retryFailureDetail),
          {
            event: storedEvent.event,
            direction: 'out',
            eventId: message.event_id,
          }
        );

        logMessageRelayDiagnostics(
          'retry-failed',
          {
            messageId: normalizedMessageId,
            eventId: message.event_id,
            relayUrl: normalizedRelayUrl,
            scope,
            trigger,
            error: retryFailureDetail,
          },
          'warn'
        );

        throw error;
      }
    })().finally(() => {
      pendingDirectMessageRelayRetryPromises.delete(retryKey);
    });

    pendingDirectMessageRelayRetryPromises.set(retryKey, retryPromise);
    return retryPromise;
  }

  async function retryGroupEpochTicketRelay(eventId: string, relayUrl: string): Promise<void> {
    const normalizedEventId = normalizeEventId(eventId);
    const normalizedRelayUrl = normalizeRelayStatusUrl(relayUrl);
    if (!normalizedEventId || !normalizedRelayUrl) {
      throw new Error('Invalid group ticket relay retry input.');
    }

    await Promise.all([
      contactsService.init(),
      chatDataService.init(),
      nostrEventDataService.init(),
    ]);

    const storedEvent = await nostrEventDataService.getEventById(normalizedEventId);
    if (!storedEvent || storedEvent.direction !== 'out') {
      throw new Error('No outbound group ticket event found for retry.');
    }

    const signedEpochTicketEvent = createStoredSignedEvent(storedEvent.event);
    if (!signedEpochTicketEvent || signedEpochTicketEvent.kind !== 1014) {
      throw new Error('Failed to rebuild the group epoch ticket for retry.');
    }

    const groupPublicKey = inputSanitizerService.normalizeHexKey(storedEvent.event.pubkey);
    const memberPublicKey = inputSanitizerService.normalizeHexKey(
      readFirstTagValue(storedEvent.event.tags, 'p') ?? ''
    );
    const epochNumber = readEpochNumberTag(storedEvent.event.tags);
    const createdAt = toIsoTimestampFromUnix(storedEvent.event.created_at);
    if (!groupPublicKey || !memberPublicKey || epochNumber === null || !createdAt) {
      throw new Error('Stored group epoch ticket is missing retry metadata.');
    }

    const groupContact = await contactsService.getContactByPublicKey(groupPublicKey);
    if (!groupContact || groupContact.type !== 'group') {
      throw new Error('Group contact not found for retry.');
    }

    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const normalizedOwnerPublicKey = inputSanitizerService.normalizeHexKey(
      groupContact.meta.owner_public_key ?? ''
    );
    if (
      !loggedInPubkeyHex ||
      !normalizedOwnerPublicKey ||
      normalizedOwnerPublicKey !== loggedInPubkeyHex
    ) {
      throw new Error('Only the owner can retry group epoch ticket delivery.');
    }

    const { secret } = await ensureGroupIdentitySecretEpochState(groupContact, []);
    const groupSigner = new NDKPrivateKeySigner(secret.group_privkey, ndk);
    const signerUser = await groupSigner.user();
    if (inputSanitizerService.normalizeHexKey(signerUser.pubkey) !== groupPublicKey) {
      throw new Error('Decrypted group private key does not match the group public key.');
    }

    await appendRelayStatusesToGroupMemberTicketEvent(
      groupPublicKey,
      memberPublicKey,
      epochNumber,
      buildPendingOutboundRelayStatuses([normalizedRelayUrl], 'recipient'),
      {
        event: storedEvent.event,
        direction: 'out',
        eventId: normalizedEventId,
        createdAt,
      }
    );

    try {
      await ensureRelayConnections([normalizedRelayUrl]);
      const recipient = new NDKUser({ pubkey: memberPublicKey });
      const giftWrapEvent = await giftWrapSignedEvent(
        signedEpochTicketEvent,
        recipient,
        groupSigner
      );
      const publishResult = await publishEventWithRelayStatuses(
        giftWrapEvent as { kind: number },
        [normalizedRelayUrl],
        'recipient'
      );

      await appendRelayStatusesToGroupMemberTicketEvent(
        groupPublicKey,
        memberPublicKey,
        epochNumber,
        publishResult.relayStatuses,
        {
          event: storedEvent.event,
          direction: 'out',
          eventId: normalizedEventId,
          createdAt,
        }
      );

      if (publishResult.error) {
        const failedRelayStatus = publishResult.relayStatuses.find(
          (relayStatus) =>
            relayStatus.relay_url === normalizedRelayUrl && relayStatus.status === 'failed'
        );
        const detail = failedRelayStatus?.detail?.trim();
        if (detail) {
          throw new Error(detail);
        }

        throw publishResult.error;
      }
    } catch (error) {
      const retryFailureDetail =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to publish epoch ticket.';

      await appendRelayStatusesToGroupMemberTicketEvent(
        groupPublicKey,
        memberPublicKey,
        epochNumber,
        buildFailedOutboundRelayStatuses([normalizedRelayUrl], 'recipient', retryFailureDetail),
        {
          event: storedEvent.event,
          direction: 'out',
          eventId: normalizedEventId,
          createdAt,
        }
      );

      throw error;
    }
  }

  return {
    getNip05Data,
    resolveIdentifier,
    retryDirectMessageRelay,
    retryGroupEpochTicketRelay,
    savePrivateKey,
    savePrivateKeyFromNsec,
    sendDirectMessage,
    sendDirectMessageDeletion,
    sendDirectMessageReaction,
    validateNpub,
    validateNsec,
    validatePrivateKey,
  };
}
