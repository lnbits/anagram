import NDK, {
  NDKEvent,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKUser,
  type NostrEvent,
} from '@nostr-dev-kit/ndk';
import { type ChatRow, chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { MUTE_LIST_KIND } from 'src/stores/nostr/constants';
import { createReadyRelaySet, fetchEventWithRelayTimeout } from 'src/stores/nostr/relayQueryUtils';
import type { ContactMetadata, ContactRecord } from 'src/types/contact';

interface MuteListRuntimeDeps {
  beginStartupStep: (stepId: 'mute-list') => void;
  buildMuteListTags: (mutedPubkeys: string[], blockedPubkeys: string[]) => string[][];
  bumpContactListVersion: () => void;
  chatStore: { reload: () => Promise<void> };
  completeStartupStep: (stepId: 'mute-list') => void;
  decryptMuteListContent: (content: string) => Promise<MuteListContent>;
  encryptMuteListTags: (tags: string[][]) => Promise<string>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  failStartupStep: (stepId: 'mute-list', error: unknown) => void;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NDKUser>;
  ndk: NDK;
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  updateStartupInternalTask: (
    parentStepId: 'contact-cursor-state',
    taskId: 'mute-list',
    updates: { eventCount?: number | null }
  ) => void;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
}

export interface MuteListContent {
  mutedPubkeys: string[];
  blockedPubkeys: string[];
}

interface BlockTargetOptions {
  fallbackName?: string;
  type?: ContactRecord['type'];
}

const CHAT_INBOX_STATE_META_KEY = 'inbox_state';
const CHAT_BLOCKED_AT_META_KEY = 'blocked_at';
const CONTACT_BLOCKED_AT_META_KEY = 'blocked_at';

function normalizeListPubkeys(pubkeys: string[], loggedInPubkeyHex: string | null): string[] {
  const normalizedPubkeys = pubkeys
    .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
    .filter((pubkey): pubkey is string => Boolean(pubkey) && pubkey !== loggedInPubkeyHex);

  return normalizedPubkeys
    .filter((pubkey, index, list) => list.indexOf(pubkey) === index)
    .sort((first, second) => first.localeCompare(second));
}

function normalizeMuteListContent(
  content: MuteListContent,
  loggedInPubkeyHex: string | null
): MuteListContent {
  const blockedPubkeys = normalizeListPubkeys(content.blockedPubkeys, loggedInPubkeyHex);
  const blockedPubkeySet = new Set(blockedPubkeys);
  const mutedPubkeys = normalizeListPubkeys(content.mutedPubkeys, loggedInPubkeyHex).filter(
    (pubkey) => !blockedPubkeySet.has(pubkey)
  );

  return {
    blockedPubkeys,
    mutedPubkeys,
  };
}

function normalizeMuteTargetPubkey(
  pubkey: string,
  loggedInPubkeyHex: string | null
): string | null {
  const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkey);
  if (!normalizedPubkey || normalizedPubkey === loggedInPubkeyHex) {
    return null;
  }

  return normalizedPubkey;
}

function isMutedMeta(meta: { muted?: unknown } | null | undefined): boolean {
  return meta?.muted === true;
}

function isBlockedContactMeta(meta: { blocked?: unknown } | null | undefined): boolean {
  return meta?.blocked === true;
}

function isBlockedChatMeta(meta: Record<string, unknown> | null | undefined): boolean {
  return meta?.[CHAT_INBOX_STATE_META_KEY] === 'blocked';
}

function readMetaString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildMutedMeta<TMeta extends { muted?: unknown }>(meta: TMeta, muted: boolean): TMeta {
  const nextMeta = { ...meta };
  if (muted) {
    nextMeta.muted = true;
    return nextMeta;
  }

  delete nextMeta.muted;
  return nextMeta;
}

function buildBlockedContactMeta(
  meta: ContactMetadata,
  blocked: boolean,
  blockedAt: string
): ContactMetadata {
  const nextMeta = { ...meta };
  if (blocked) {
    nextMeta.blocked = true;
    if (!readMetaString(nextMeta as Record<string, unknown>, CONTACT_BLOCKED_AT_META_KEY)) {
      nextMeta.blocked_at = blockedAt;
    }
    delete nextMeta.muted;
    return nextMeta;
  }

  delete nextMeta.blocked;
  delete nextMeta.blocked_at;
  return nextMeta;
}

function buildBlockedChatMeta(
  meta: Record<string, unknown>,
  blocked: boolean,
  blockedAt: string
): Record<string, unknown> {
  const nextMeta = { ...meta };
  if (blocked) {
    nextMeta[CHAT_INBOX_STATE_META_KEY] = 'blocked';
    if (!readMetaString(nextMeta, CHAT_BLOCKED_AT_META_KEY)) {
      nextMeta[CHAT_BLOCKED_AT_META_KEY] = blockedAt;
    }
    delete nextMeta.muted;
    return nextMeta;
  }

  if (nextMeta[CHAT_INBOX_STATE_META_KEY] === 'blocked') {
    delete nextMeta[CHAT_INBOX_STATE_META_KEY];
  }
  delete nextMeta[CHAT_BLOCKED_AT_META_KEY];
  return nextMeta;
}

function normalizeContactMeta(meta: ContactRecord['meta'] | undefined): ContactMetadata {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
}

function normalizeChatMeta(meta: ChatRow['meta'] | undefined): Record<string, unknown> {
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...meta } : {};
}

function eventToNdkEvent(ndk: NDK, event: NDKEvent | NostrEvent): NDKEvent {
  return event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
}

function metadataEqual(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function buildBlockedContactName(pubkey: string, options: BlockTargetOptions | undefined): string {
  const fallbackName = options?.fallbackName?.trim();
  return fallbackName || pubkey.slice(0, 16);
}

export function createMuteListRuntime({
  beginStartupStep,
  buildMuteListTags,
  bumpContactListVersion,
  chatStore,
  completeStartupStep,
  decryptMuteListContent,
  encryptMuteListTags,
  ensureRelayConnections,
  failStartupStep,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  ndk,
  resolveLoggedInPublishRelayUrls,
  resolveLoggedInReadRelayUrls,
  updateStartupInternalTask,
  updateStoredEventSinceFromCreatedAt,
}: MuteListRuntimeDeps) {
  let restoreMuteListPromise: Promise<void> | null = null;
  let muteListMutationQueue = Promise.resolve();
  let mutedPubkeySet = new Set<string>();
  let blockedPubkeySet = new Set<string>();
  let hasRestoredMuteList = false;

  function isPubkeyMuted(pubkey: string): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkey);
    return normalizedPubkey ? mutedPubkeySet.has(normalizedPubkey) : false;
  }

  function isPubkeyBlocked(pubkey: string): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(pubkey);
    return normalizedPubkey ? blockedPubkeySet.has(normalizedPubkey) : false;
  }

  function updateMuteListStartupEntryCount(entryCount: number): void {
    updateStartupInternalTask('contact-cursor-state', 'mute-list', {
      eventCount: Math.max(0, Math.floor(entryCount)),
    });
  }

  async function applyMuteListContent(
    content: MuteListContent,
    optionsByBlockedPubkey = new Map<string, BlockTargetOptions>()
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const { mutedPubkeys, blockedPubkeys } = normalizeMuteListContent(content, loggedInPubkeyHex);
    const nextMutedPubkeySet = new Set(mutedPubkeys);
    const nextBlockedPubkeySet = new Set(blockedPubkeys);
    const now = new Date().toISOString();
    let didChangeContacts = false;
    let didChangeChats = false;

    await Promise.all([contactsService.init(), chatDataService.init()]);
    const [contacts, chats] = await Promise.all([
      contactsService.listContacts(),
      chatDataService.listChats(),
    ]);
    const existingContactPubkeys = new Set<string>();
    const chatByPubkey = new Map<string, ChatRow>();

    for (const chat of chats) {
      const normalizedPubkey = normalizeMuteTargetPubkey(chat.public_key, loggedInPubkeyHex);
      if (normalizedPubkey) {
        chatByPubkey.set(normalizedPubkey, chat);
      }
    }

    for (const contact of contacts) {
      const normalizedPubkey = normalizeMuteTargetPubkey(contact.public_key, loggedInPubkeyHex);
      if (!normalizedPubkey) {
        continue;
      }
      existingContactPubkeys.add(normalizedPubkey);

      const shouldMute = nextMutedPubkeySet.has(normalizedPubkey);
      const shouldBlock = nextBlockedPubkeySet.has(normalizedPubkey);
      const contactMeta = normalizeContactMeta(contact.meta);
      const nextContactMeta = buildBlockedContactMeta(
        buildMutedMeta(contactMeta, shouldMute),
        shouldBlock,
        now
      );
      if (
        isMutedMeta(contactMeta) === shouldMute &&
        isBlockedContactMeta(contactMeta) === shouldBlock &&
        metadataEqual(
          contactMeta as Record<string, unknown>,
          nextContactMeta as Record<string, unknown>
        )
      ) {
        continue;
      }

      await contactsService.updateContact(contact.id, {
        meta: nextContactMeta,
      });
      didChangeContacts = true;
    }

    for (const blockedPubkey of blockedPubkeys) {
      if (existingContactPubkeys.has(blockedPubkey)) {
        continue;
      }

      const chat = chatByPubkey.get(blockedPubkey);
      const options = optionsByBlockedPubkey.get(blockedPubkey);
      const contactType = options?.type ?? (chat?.type === 'group' ? 'group' : 'user');
      const createdContact = await contactsService.createContact({
        public_key: blockedPubkey,
        type: contactType,
        name: chat?.name?.trim() || buildBlockedContactName(blockedPubkey, options),
        meta: {
          blocked: true,
          blocked_at: now,
          ...(contactType === 'group' ? { group: true } : {}),
        },
      });

      if (createdContact) {
        didChangeContacts = true;
      }
    }

    for (const chat of chats) {
      const normalizedPubkey = normalizeMuteTargetPubkey(chat.public_key, loggedInPubkeyHex);
      if (!normalizedPubkey) {
        continue;
      }

      const shouldMute = nextMutedPubkeySet.has(normalizedPubkey);
      const shouldBlock = nextBlockedPubkeySet.has(normalizedPubkey);
      const chatMeta = normalizeChatMeta(chat.meta);
      const nextChatMeta = buildBlockedChatMeta(
        buildMutedMeta(chatMeta, shouldMute),
        shouldBlock,
        now
      );
      const shouldMarkChatRead = shouldBlock && Number(chat.unread_count ?? 0) > 0;

      if (
        isMutedMeta(chatMeta) !== shouldMute ||
        isBlockedChatMeta(chatMeta) !== shouldBlock ||
        !metadataEqual(chatMeta, nextChatMeta)
      ) {
        await chatDataService.updateChatMeta(chat.public_key, nextChatMeta);
        didChangeChats = true;
      }

      if (shouldMarkChatRead) {
        await chatDataService.markChatAsRead(chat.public_key);
        didChangeChats = true;
      }
    }

    mutedPubkeySet = nextMutedPubkeySet;
    blockedPubkeySet = nextBlockedPubkeySet;

    if (didChangeContacts) {
      bumpContactListVersion();
    }

    if (didChangeChats) {
      await chatStore.reload();
    }
  }

  async function applyMuteListPubkeys(pubkeys: string[]): Promise<void> {
    return applyMuteListContent({
      blockedPubkeys: [],
      mutedPubkeys: pubkeys,
    });
  }

  async function fetchMuteListContent(
    seedRelayUrls: string[] = []
  ): Promise<MuteListContent | null> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return null;
    }

    const relayUrls = await resolveLoggedInReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      return null;
    }

    await ensureRelayConnections(relayUrls);
    await getLoggedInSignerUser();

    const relaySet = createReadyRelaySet(ndk, relayUrls);
    const fetchedEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [MUTE_LIST_KIND],
        authors: [loggedInPubkeyHex],
      },
      {
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
      },
      relaySet
    );
    if (!fetchedEvent) {
      return {
        blockedPubkeys: [],
        mutedPubkeys: [],
      };
    }

    const muteListEvent = eventToNdkEvent(ndk, fetchedEvent);
    updateStoredEventSinceFromCreatedAt(muteListEvent.created_at);
    return decryptMuteListContent(muteListEvent.content);
  }

  async function restoreMuteList(seedRelayUrls: string[] = []): Promise<void> {
    if (restoreMuteListPromise) {
      return restoreMuteListPromise;
    }

    beginStartupStep('mute-list');
    restoreMuteListPromise = (async () => {
      try {
        const content = await fetchMuteListContent(seedRelayUrls);
        if (content !== null) {
          const normalizedContent = normalizeMuteListContent(content, getLoggedInPublicKeyHex());
          updateMuteListStartupEntryCount(
            normalizedContent.mutedPubkeys.length + normalizedContent.blockedPubkeys.length
          );
          await applyMuteListContent(normalizedContent);
          hasRestoredMuteList = true;
        }

        completeStartupStep('mute-list');
      } catch (error) {
        failStartupStep('mute-list', error);
        throw error;
      }
    })().finally(() => {
      restoreMuteListPromise = null;
    });

    return restoreMuteListPromise;
  }

  async function publishMuteList(seedRelayUrls: string[] = []): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    const relayUrls = await resolveLoggedInPublishRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish mute list without at least one relay.');
    }

    await ensureRelayConnections(relayUrls);
    const user = await getLoggedInSignerUser();
    const { mutedPubkeys, blockedPubkeys } = normalizeMuteListContent(
      {
        mutedPubkeys: Array.from(mutedPubkeySet),
        blockedPubkeys: Array.from(blockedPubkeySet),
      },
      loggedInPubkeyHex
    );
    const muteListEvent = new NDKEvent(ndk, {
      kind: MUTE_LIST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: user.pubkey,
      content: await encryptMuteListTags(buildMuteListTags(mutedPubkeys, blockedPubkeys)),
      tags: [],
    });

    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    await muteListEvent.publishReplaceable(relaySet);
    updateStoredEventSinceFromCreatedAt(muteListEvent.created_at);
    hasRestoredMuteList = true;
  }

  async function setPubkeyMuted(
    pubkey: string,
    muted: boolean,
    seedRelayUrls: string[] = []
  ): Promise<void> {
    const mutation = muteListMutationQueue.then(async () => {
      if (!hasRestoredMuteList) {
        await restoreMuteList(seedRelayUrls);
      }

      const loggedInPubkeyHex = getLoggedInPublicKeyHex();
      const normalizedPubkey = normalizeMuteTargetPubkey(pubkey, loggedInPubkeyHex);
      if (!normalizedPubkey) {
        return;
      }

      if (muted && blockedPubkeySet.has(normalizedPubkey)) {
        return;
      }

      const nextMutedPubkeys = new Set(mutedPubkeySet);
      if (muted) {
        nextMutedPubkeys.add(normalizedPubkey);
      } else {
        nextMutedPubkeys.delete(normalizedPubkey);
      }

      if (
        nextMutedPubkeys.size === mutedPubkeySet.size &&
        nextMutedPubkeys.has(normalizedPubkey) === muted
      ) {
        return;
      }

      await applyMuteListContent({
        mutedPubkeys: Array.from(nextMutedPubkeys),
        blockedPubkeys: Array.from(blockedPubkeySet),
      });
      await publishMuteList(seedRelayUrls);
    });

    muteListMutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  async function setPubkeyBlocked(
    pubkey: string,
    blocked: boolean,
    seedRelayUrls: string[] = [],
    options: BlockTargetOptions = {}
  ): Promise<void> {
    const mutation = muteListMutationQueue.then(async () => {
      if (!hasRestoredMuteList) {
        await restoreMuteList(seedRelayUrls);
      }

      const loggedInPubkeyHex = getLoggedInPublicKeyHex();
      const normalizedPubkey = normalizeMuteTargetPubkey(pubkey, loggedInPubkeyHex);
      if (!normalizedPubkey) {
        return;
      }

      const nextMutedPubkeys = new Set(mutedPubkeySet);
      const nextBlockedPubkeys = new Set(blockedPubkeySet);
      if (blocked) {
        nextBlockedPubkeys.add(normalizedPubkey);
        nextMutedPubkeys.delete(normalizedPubkey);
      } else {
        nextBlockedPubkeys.delete(normalizedPubkey);
      }

      if (
        nextBlockedPubkeys.size === blockedPubkeySet.size &&
        nextBlockedPubkeys.has(normalizedPubkey) === blocked &&
        nextMutedPubkeys.size === mutedPubkeySet.size
      ) {
        return;
      }

      await applyMuteListContent(
        {
          mutedPubkeys: Array.from(nextMutedPubkeys),
          blockedPubkeys: Array.from(nextBlockedPubkeys),
        },
        blocked
          ? new Map<string, BlockTargetOptions>([[normalizedPubkey, options]])
          : new Map<string, BlockTargetOptions>()
      );
      await publishMuteList(seedRelayUrls);
    });

    muteListMutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  function resetMuteListRuntimeState(): void {
    restoreMuteListPromise = null;
    muteListMutationQueue = Promise.resolve();
    mutedPubkeySet = new Set<string>();
    blockedPubkeySet = new Set<string>();
    hasRestoredMuteList = false;
  }

  return {
    applyMuteListContent,
    applyMuteListPubkeys,
    isPubkeyBlocked,
    isPubkeyMuted,
    publishMuteList,
    resetMuteListRuntimeState,
    restoreMuteList,
    setPubkeyBlocked,
    setPubkeyMuted,
  };
}
