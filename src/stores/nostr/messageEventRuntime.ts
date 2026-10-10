import NostrClient, {
  ClientEvent,
  NostrKind,
  NostrPrivateKeySigner,
  type NostrSigner,
  NostrUser,
  type NostrEvent,
} from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { INVITATION_PROOF_TAG } from '#src/stores/nostr/constants.ts';
import type { ChatRow } from '#src/services/chatDataService.ts';
import type { ChatGroupEpochKey } from '#src/types/chat.ts';
import {
  groupInteger,
  singleGroupTag,
  verifyGroupMembershipProof,
  verifyGroupMessage,
  type GroupMessageEpoch,
} from '#src/stores/nostr/groupMessageAuthorization.ts';

interface GroupEpochContext {
  chat: ChatRow;
  epochEntry: ChatGroupEpochKey;
}

interface MessageEventRuntimeDeps {
  issueOwnGroupInvitation: (
    group: string,
    epoch: string,
  ) => Promise<{ proof: string; invitedAt: number } | null>;
  getLoggedInPublicKeyHex: () => string | null;
  decryptPrivateStringContent: (value: string) => Promise<string | null>;
  derivePublicKeyFromPrivateKey: (privateKey: string) => string | null;
  findGroupChatEpochContextByRecipientPubkey: (
    epochPublicKey: string
  ) => Promise<GroupEpochContext | null>;
  getOrCreateSigner: () => Promise<NostrSigner>;
  ndk: NostrClient;
  readEpochNumberTag: (tags: string[][]) => number | null;
  readFirstTagValue: (tags: string[][], tagName: string) => string | null;
}

export function createMessageEventRuntime({
  issueOwnGroupInvitation,
  getLoggedInPublicKeyHex,
  decryptPrivateStringContent,
  derivePublicKeyFromPrivateKey,
  findGroupChatEpochContextByRecipientPubkey,
  getOrCreateSigner,
  ndk,
  readEpochNumberTag,
  readFirstTagValue,
}: MessageEventRuntimeDeps) {
  async function messageEpoch(context: GroupEpochContext): Promise<GroupMessageEpoch | null> {
    const key = await decryptPrivateStringContent(
      context.epochEntry.epoch_private_key_encrypted,
    );
    if (!key || derivePublicKeyFromPrivateKey(key) !== context.epochEntry.epoch_public_key)
      return null;
    return {
      groupPublicKey: context.chat.public_key,
      epochNumber: context.epochEntry.epoch_number,
      epochPublicKey: context.epochEntry.epoch_public_key,
      epochPrivateKey: key,
    };
  }

  async function verifyIncomingGroupMessage(
    rumor: ClientEvent,
    recipient: string,
  ): Promise<boolean> {
    const context = await findGroupChatEpochContextByRecipientPubkey(recipient);
    if (!context || (await findGroupChatEpochContextByRecipientPubkey(rumor.pubkey)))
      return false;
    const epoch = await messageEpoch(context);
    return epoch !== null && verifyGroupMessage(rumor, epoch);
  }

  async function prepareOutgoingPrivateMessage(
    rumor: ClientEvent,
    recipient: string,
    retry = false,
  ): Promise<void> {
    const account = getLoggedInPublicKeyHex();
    if (!account || rumor.pubkey !== account)
      throw new Error('The message author does not match the active account.');
    const context = await findGroupChatEpochContextByRecipientPubkey(recipient);
    if (context) {
      const { chat, epochEntry } = context;
      if (
        Number(chat.meta.group_conflicting_epoch ?? -1) >= epochEntry.epoch_number ||
        chat.meta.current_epoch_public_key !== recipient
      )
        throw new Error('Refresh the group invitation before sending to this epoch.');
      const epoch = await messageEpoch(context);
      if (!epoch || (await findGroupChatEpochContextByRecipientPubkey(account)))
        throw new Error('A group epoch key cannot be used as a message identity.');
      if (!retry) {
        let proof = epochEntry.invitation_proof;
        let invitedAt = Date.parse(epochEntry.invitation_created_at ?? '') / 1000;
        if (!proof || !(await verifyGroupMembershipProof(epoch, account, invitedAt, proof))) {
          const invitation = await issueOwnGroupInvitation(chat.public_key, recipient);
          if (getLoggedInPublicKeyHex() !== account)
            throw new Error('The active account changed. Reopen the conversation.');
          if (!invitation)
            throw new Error('Your signed group invitation is missing. Ask an owner to resend it.');
          proof = invitation.proof;
          invitedAt = invitation.invitedAt;
        }
        // A reaction's target author p tag is a DM convention; groups have one recipient.
        const tags = rumor.tags.filter(
          (tag) => !['p', 'h', 'epoch', 'invited_at', 'invitation_proof'].includes(tag[0]),
        );
        rumor.tags = [
          ['p', recipient],
          ['h', chat.public_key],
          ['epoch', String(epoch.epochNumber)],
          ['invited_at', String(invitedAt)],
          ['invitation_proof', proof],
          ...tags,
        ];
      }
      if (!(await verifyGroupMessage(rumor, epoch)))
        throw new Error(
          'This group message has no valid membership proof. Send a new message with a current invitation.',
        );
    }
    if (getLoggedInPublicKeyHex() !== account)
      throw new Error('The active account changed. Reopen the conversation.');
  }

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
  ): ClientEvent {
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

    return new ClientEvent(ndk, {
      kind: NostrKind.PrivateDirectMessage,
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
  ): ClientEvent {
    return new ClientEvent(ndk, {
      kind: NostrKind.Reaction,
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
  ): ClientEvent {
    return new ClientEvent(ndk, {
      kind: NostrKind.EventDeletion,
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

  function createStoredSignedEvent(event: NostrEvent): ClientEvent | null {
    const pubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!pubkey) {
      return null;
    }

    const tags = Array.isArray(event.tags)
      ? event.tags
          .filter((tag): tag is string[] => Array.isArray(tag))
          .map((tag) => tag.map((entry) => String(entry)))
      : [];

    return new ClientEvent(ndk, {
      kind: typeof event.kind === 'number' ? event.kind : NostrKind.PrivateDirectMessage,
      created_at: event.created_at,
      pubkey,
      content: event.content,
      tags,
      ...(event.id?.trim() ? { id: event.id.trim() } : {}),
      ...(event.sig?.trim() ? { sig: event.sig.trim() } : {}),
    });
  }

  function createStoredDirectMessageRumorEvent(event: NostrEvent): ClientEvent | null {
    return createStoredSignedEvent(event);
  }

  function approximateGiftWrapNow(drift = 5): number {
    return Math.round(Date.now() / 1000 - Math.random() * 10 ** drift);
  }

  async function giftWrapSignedEvent(
    event: ClientEvent,
    recipient: NostrUser,
    signer: NostrSigner,
  ): Promise<ClientEvent> {
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

    const sealEvent = new ClientEvent(ndk, {
      kind: NostrKind.GiftWrapSeal,
      created_at: approximateGiftWrapNow(),
      pubkey: event.pubkey,
      content: JSON.stringify(rumorPayload),
      tags: [[INVITATION_PROOF_TAG, invitationProof]],
    });
    await sealEvent.encrypt(recipient, signer, 'nip44');
    await sealEvent.sign(signer);

    const wrapSigner = NostrPrivateKeySigner.generate();
    const giftWrapEvent = new ClientEvent(ndk, {
      kind: NostrKind.GiftWrap,
      created_at: approximateGiftWrapNow(),
      content: JSON.stringify(sealEvent.rawEvent()),
      tags: [['p', recipient.pubkey]],
    });
    await giftWrapEvent.encrypt(recipient, wrapSigner, 'nip44');
    await giftWrapEvent.sign(wrapSigner);

    return giftWrapEvent;
  }

  async function toStoredNostrEvent(event: ClientEvent): Promise<NostrEvent | null> {
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
        kind: typeof event.kind === 'number' ? event.kind : 1,
      };
    }
  }

  async function unwrapGiftWrapSealEvent(
    wrappedEvent: ClientEvent,
  ): Promise<NostrEvent | null> {
    const normalizedContent = wrappedEvent.content.trim();
    const wrapAuthorPubkey = inputSanitizerService.normalizeHexKey(wrappedEvent.pubkey ?? '');
    if (!normalizedContent || !wrapAuthorPubkey) {
      return null;
    }

    ndk.assertSigner();
    const wrapAuthor = new NostrUser({ pubkey: wrapAuthorPubkey });
    const decryptedContent = await ndk.signer.decrypt(wrapAuthor, normalizedContent, 'nip44');

    try {
      const rawSeal = JSON.parse(decryptedContent) as Partial<NostrEvent>;
      const sealEvent = new ClientEvent(ndk, rawSeal);
      if (!sealEvent.verifySignature(false)) {
        return null;
      }

      return await toStoredNostrEvent(sealEvent);
    } catch {
      return null;
    }
  }

  async function verifyIncomingGroupEpochTicket(
    rumorEvent: ClientEvent,
    sealEvent: NostrEvent | null,
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
    if (
      !invitationProof ||
      epochNumber === null ||
      !epochPrivateKey ||
      rumorEvent.kind !== 1014 ||
      !Number.isSafeInteger(rumorEvent.created_at) ||
      Number(rumorEvent.created_at) < 0 ||
      rumorEvent.content !== epochPrivateKey ||
      JSON.stringify(rumorEvent.tags) !==
        JSON.stringify([
          ['p', singleGroupTag(rumorEvent.tags, 'p')],
          ['epoch', String(epochNumber)],
        ]) ||
      groupInteger(singleGroupTag(rumorEvent.tags, 'epoch')) !== epochNumber ||
      !/^[0-9a-f]{64}$/.test(singleGroupTag(rumorEvent.tags, 'p') ?? '') ||
      singleGroupTag(sealTags, INVITATION_PROOF_TAG) !== invitationProof
    ) {
      return {
        isValid: false,
        signedEvent: null,
        epochNumber,
        epochPrivateKey,
      };
    }

    const signedEvent = new ClientEvent(ndk, {
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
    wrappedEvent: ClientEvent,
    loggedInPubkeyHex: string
  ): Promise<{
    recipientPubkey: string;
    unwrapSigner: NostrSigner;
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
      unwrapSigner: new NostrPrivateKeySigner(decryptedCurrentEpochPrivateKey, ndk),
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

  function readReactionTargetEventId(event: ClientEvent): string | null {
    return normalizeEventId(event.getMatchingTags('e')[0]?.[1] ?? '');
  }

  function readReplyTargetEventId(event: ClientEvent): string | null {
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

  function readReactionTargetAuthorPubkey(event: ClientEvent): string | null {
    return inputSanitizerService.normalizeHexKey(event.getMatchingTags('p')[1]?.[1] ?? '');
  }

  function readDeletionTargetEntries(
    event: ClientEvent
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
    prepareOutgoingPrivateMessage,
    verifyIncomingGroupMessage,
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
