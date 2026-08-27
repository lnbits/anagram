import NDK, {
  NDKEvent,
  NDKKind,
  NDKPrivateKeySigner,
  type NDKSigner,
  NDKUser,
  type NostrEvent,
} from '@nostr-dev-kit/ndk';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { INVITATION_PROOF_TAG } from 'src/stores/nostr/constants';

interface GroupEpochContext {
  chat: {
    public_key: string;
  };
  epochEntry: {
    epoch_private_key_encrypted?: string | null;
  };
}

interface MessageEventRuntimeDeps {
  decryptPrivateStringContent: (value: string) => Promise<string | null>;
  derivePublicKeyFromPrivateKey: (privateKey: string) => string | null;
  findGroupChatEpochContextByRecipientPubkey: (
    epochPublicKey: string
  ) => Promise<GroupEpochContext | null>;
  getOrCreateSigner: () => Promise<NDKSigner>;
  ndk: NDK;
  readEpochNumberTag: (tags: string[][]) => number | null;
  readFirstTagValue: (tags: string[][], tagName: string) => string | null;
}

export function createMessageEventRuntime({
  decryptPrivateStringContent,
  derivePublicKeyFromPrivateKey,
  findGroupChatEpochContextByRecipientPubkey,
  getOrCreateSigner,
  ndk,
  readEpochNumberTag,
  readFirstTagValue,
}: MessageEventRuntimeDeps) {
  function normalizeEventId(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim().toLowerCase();
    return trimmed || null;
  }

  function createDirectMessageRumorEvent(
    senderPubkey: string,
    recipientPubkey: string,
    message: string,
    createdAt: number,
    replyToEventId?: string | null,
    additionalTags: string[][] = []
  ): NDKEvent {
    const tags: string[][] = [['p', recipientPubkey]];
    const normalizedReplyTargetEventId = normalizeEventId(replyToEventId);
    if (normalizedReplyTargetEventId) {
      tags.push(['e', normalizedReplyTargetEventId, '', 'reply']);
    }

    for (const tag of additionalTags) {
      if (!Array.isArray(tag) || tag.length === 0) {
        continue;
      }

      const normalizedTag = tag.map((entry) => String(entry).trim());
      if (normalizedTag[0]) {
        tags.push(normalizedTag);
      }
    }

    return new NDKEvent(ndk, {
      kind: NDKKind.PrivateDirectMessage,
      created_at: createdAt,
      pubkey: senderPubkey,
      content: message,
      tags,
    });
  }

  function createReactionRumorEvent(
    senderPubkey: string,
    recipientPubkey: string,
    emoji: string,
    targetEventId: string,
    targetAuthorPubkey: string,
    targetKind: number,
    createdAt: number
  ): NDKEvent {
    return new NDKEvent(ndk, {
      kind: NDKKind.Reaction,
      created_at: createdAt,
      pubkey: senderPubkey,
      content: emoji,
      tags: [
        ['p', recipientPubkey],
        ['e', targetEventId],
        ['p', targetAuthorPubkey],
        ['k', String(targetKind)],
      ],
    });
  }

  function createEventDeletionRumorEvent(
    senderPubkey: string,
    recipientPubkey: string,
    targetEventId: string,
    targetKind: number,
    createdAt: number
  ): NDKEvent {
    return new NDKEvent(ndk, {
      kind: NDKKind.EventDeletion,
      created_at: createdAt,
      pubkey: senderPubkey,
      content: '',
      tags: [
        ['p', recipientPubkey],
        ['e', targetEventId],
        ['k', String(targetKind)],
      ],
    });
  }

  function createStoredSignedEvent(event: NostrEvent): NDKEvent | null {
    const pubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!pubkey) {
      return null;
    }

    const tags = Array.isArray(event.tags)
      ? event.tags
          .filter((tag): tag is string[] => Array.isArray(tag))
          .map((tag) => tag.map((entry) => String(entry)))
      : [];

    return new NDKEvent(ndk, {
      kind: typeof event.kind === 'number' ? event.kind : NDKKind.PrivateDirectMessage,
      created_at: event.created_at,
      pubkey,
      content: event.content,
      tags,
      ...(event.id?.trim() ? { id: event.id.trim() } : {}),
      ...(event.sig?.trim() ? { sig: event.sig.trim() } : {}),
    });
  }

  function createStoredDirectMessageRumorEvent(event: NostrEvent): NDKEvent | null {
    return createStoredSignedEvent(event);
  }

  function approximateGiftWrapNow(drift = 5): number {
    return Math.round(Date.now() / 1000 - Math.random() * 10 ** drift);
  }

  async function giftWrapSignedEvent(
    event: NDKEvent,
    recipient: NDKUser,
    signer: NDKSigner
  ): Promise<NDKEvent> {
    if (!event.sig) {
      throw new Error('Signed event is required before gift wrapping.');
    }

    const invitationProof = event.sig.trim();
    if (!invitationProof) {
      throw new Error('Signed event is missing a valid signature.');
    }

    const rumorPayload: NostrEvent = {
      created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      content: event.content,
      tags: event.tags.map((tag) => [...tag]),
      kind: event.kind,
      pubkey: event.pubkey,
      ...(event.id?.trim() ? { id: event.id.trim() } : {}),
    };

    const sealEvent = new NDKEvent(ndk, {
      kind: NDKKind.GiftWrapSeal,
      created_at: approximateGiftWrapNow(),
      pubkey: event.pubkey,
      content: JSON.stringify(rumorPayload),
      tags: [[INVITATION_PROOF_TAG, invitationProof]],
    });
    await sealEvent.encrypt(recipient, signer, 'nip44');
    await sealEvent.sign(signer);

    const wrapSigner = NDKPrivateKeySigner.generate();
    const giftWrapEvent = new NDKEvent(ndk, {
      kind: NDKKind.GiftWrap,
      created_at: approximateGiftWrapNow(),
      content: JSON.stringify(sealEvent.rawEvent()),
      tags: [['p', recipient.pubkey]],
    });
    await giftWrapEvent.encrypt(recipient, wrapSigner, 'nip44');
    await giftWrapEvent.sign(wrapSigner);

    return giftWrapEvent;
  }

  async function toStoredNostrEvent(event: NDKEvent): Promise<NostrEvent | null> {
    try {
      const nostrEvent = await event.toNostrEvent();
      const eventId = normalizeEventId(nostrEvent.id ?? event.id);
      if (!eventId) {
        return null;
      }

      return {
        ...nostrEvent,
        id: eventId,
      };
    } catch {
      const eventId = normalizeEventId(event.id);
      const pubkey = typeof event.pubkey === 'string' ? event.pubkey.trim() : '';
      if (!eventId || !pubkey) {
        return null;
      }

      const tags = Array.isArray(event.tags)
        ? event.tags
            .filter((tag): tag is string[] => Array.isArray(tag))
            .map((tag) => tag.map((entry) => String(entry)))
        : [];

      return {
        created_at: Number.isInteger(event.created_at)
          ? event.created_at
          : Math.floor(Date.now() / 1000),
        content: typeof event.content === 'string' ? event.content : '',
        tags,
        pubkey,
        id: eventId,
        ...(typeof event.kind === 'number' ? { kind: event.kind } : {}),
      };
    }
  }

  async function unwrapGiftWrapSealEvent(wrappedEvent: NDKEvent): Promise<NostrEvent | null> {
    const normalizedContent = wrappedEvent.content.trim();
    const wrapAuthorPubkey = inputSanitizerService.normalizeHexKey(wrappedEvent.pubkey ?? '');
    if (!normalizedContent || !wrapAuthorPubkey) {
      return null;
    }

    ndk.assertSigner();
    const wrapAuthor = new NDKUser({ pubkey: wrapAuthorPubkey });
    const decryptedContent = await ndk.signer.decrypt(wrapAuthor, normalizedContent, 'nip44');

    try {
      const rawSeal = JSON.parse(decryptedContent) as Partial<NostrEvent>;
      const sealEvent = new NDKEvent(ndk, rawSeal);
      if (!sealEvent.verifySignature(false)) {
        return null;
      }

      return await toStoredNostrEvent(sealEvent);
    } catch {
      return null;
    }
  }

  async function verifyIncomingGroupEpochTicket(
    rumorEvent: NDKEvent,
    sealEvent: NostrEvent | null
  ): Promise<{
    isValid: boolean;
    signedEvent: NostrEvent | null;
    epochNumber: number | null;
    epochPrivateKey: string | null;
  }> {
    const sealTags = Array.isArray(sealEvent?.tags)
      ? sealEvent.tags.filter((tag): tag is string[] => Array.isArray(tag))
      : [];
    const invitationProof = readFirstTagValue(sealTags, INVITATION_PROOF_TAG);
    const epochNumber = readEpochNumberTag(rumorEvent.tags);
    const epochPrivateKey = inputSanitizerService.normalizeHexKey(rumorEvent.content ?? '');
    if (!invitationProof || epochNumber === null || !epochPrivateKey) {
      return {
        isValid: false,
        signedEvent: null,
        epochNumber,
        epochPrivateKey,
      };
    }

    const signedEvent = new NDKEvent(ndk, {
      created_at: rumorEvent.created_at,
      content: rumorEvent.content,
      tags: rumorEvent.tags.map((tag) => [...tag]),
      kind: rumorEvent.kind,
      pubkey: rumorEvent.pubkey,
      ...(rumorEvent.id?.trim() ? { id: rumorEvent.id.trim() } : {}),
      sig: invitationProof,
    });
    const isValid = signedEvent.verifySignature(false) === true;

    return {
      isValid,
      signedEvent: isValid ? await toStoredNostrEvent(signedEvent) : null,
      epochNumber,
      epochPrivateKey,
    };
  }

  async function resolveIncomingPrivateMessageRecipientContext(
    wrappedEvent: NDKEvent,
    loggedInPubkeyHex: string
  ): Promise<{
    recipientPubkey: string;
    unwrapSigner: NDKSigner;
    groupChatPublicKey: string | null;
  } | null> {
    const tags = Array.isArray(wrappedEvent.tags)
      ? wrappedEvent.tags.filter((tag): tag is string[] => Array.isArray(tag))
      : [];
    const wrappedRecipientPubkey = inputSanitizerService.normalizeHexKey(
      readFirstTagValue(tags, 'p') ?? ''
    );
    if (!wrappedRecipientPubkey) {
      return null;
    }

    if (wrappedRecipientPubkey === loggedInPubkeyHex) {
      return {
        recipientPubkey: wrappedRecipientPubkey,
        unwrapSigner: await getOrCreateSigner(),
        groupChatPublicKey: null,
      };
    }

    const groupEpochContext =
      await findGroupChatEpochContextByRecipientPubkey(wrappedRecipientPubkey);
    if (!groupEpochContext?.epochEntry.epoch_private_key_encrypted) {
      return null;
    }

    const decryptedCurrentEpochPrivateKey = await decryptPrivateStringContent(
      groupEpochContext.epochEntry.epoch_private_key_encrypted
    );
    if (!decryptedCurrentEpochPrivateKey) {
      return null;
    }

    const derivedEpochPublicKey = derivePublicKeyFromPrivateKey(decryptedCurrentEpochPrivateKey);
    if (derivedEpochPublicKey !== wrappedRecipientPubkey) {
      return null;
    }

    return {
      recipientPubkey: wrappedRecipientPubkey,
      unwrapSigner: new NDKPrivateKeySigner(decryptedCurrentEpochPrivateKey, ndk),
      groupChatPublicKey: groupEpochContext.chat.public_key,
    };
  }

  function readDirectMessageRecipientPubkey(event: NostrEvent): string | null {
    if (!Array.isArray(event.tags)) {
      return null;
    }

    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag[0] !== 'p') {
        continue;
      }

      const recipientPubkey = inputSanitizerService.normalizeHexKey(tag[1] ?? '');
      if (recipientPubkey) {
        return recipientPubkey;
      }
    }

    return null;
  }

  function readReactionTargetEventId(event: NDKEvent): string | null {
    return normalizeEventId(event.getMatchingTags('e')[0]?.[1] ?? '');
  }

  function readReplyTargetEventId(event: NDKEvent): string | null {
    const replyTag = event.getMatchingTags('e').find((tag) => {
      const marker = String(tag[3] ?? '')
        .trim()
        .toLowerCase();
      return marker === 'reply' && normalizeEventId(tag[1] ?? '');
    });
    if (replyTag) {
      return normalizeEventId(replyTag[1] ?? '');
    }

    return normalizeEventId(event.getMatchingTags('e')[0]?.[1] ?? '');
  }

  function readReactionTargetAuthorPubkey(event: NDKEvent): string | null {
    return inputSanitizerService.normalizeHexKey(event.getMatchingTags('p')[1]?.[1] ?? '');
  }

  function readDeletionTargetEntries(
    event: NDKEvent
  ): Array<{ eventId: string; kind: number | null }> {
    const eventIds = event
      .getMatchingTags('e')
      .map((tag) => normalizeEventId(tag[1] ?? ''))
      .filter((eventId): eventId is string => Boolean(eventId));
    if (eventIds.length === 0) {
      return [];
    }

    const kinds = event
      .getMatchingTags('k')
      .map((tag) => Number.parseInt(String(tag[1] ?? ''), 10))
      .filter((kind) => Number.isInteger(kind) && kind > 0);
    const fallbackKind = kinds.length === 1 ? kinds[0] : null;

    return eventIds.map((eventId, index) => ({
      eventId,
      kind: kinds[index] ?? fallbackKind,
    }));
  }

  return {
    createDirectMessageRumorEvent,
    createEventDeletionRumorEvent,
    createReactionRumorEvent,
    createStoredDirectMessageRumorEvent,
    createStoredSignedEvent,
    giftWrapSignedEvent,
    normalizeEventId,
    readDeletionTargetEntries,
    readDirectMessageRecipientPubkey,
    readReactionTargetAuthorPubkey,
    readReactionTargetEventId,
    readReplyTargetEventId,
    resolveIncomingPrivateMessageRecipientContext,
    toStoredNostrEvent,
    unwrapGiftWrapSealEvent,
    verifyIncomingGroupEpochTicket,
  };
}
