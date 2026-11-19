import {
  startupRelaySignal,
  startupRelayStatuses,
} from '#src/stores/nostr/startupRelayTracking.ts';
import NostrClient, {
  ClientEvent,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  type NostrUser,
  type NostrEvent,
} from '#src/lib/nostr/client.ts';
import { type ChatRow, chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { MUTE_LIST_KIND } from '#src/stores/nostr/constants.ts';
import { fetchEventWithRelayTimeout } from '#src/stores/nostr/relayQueryUtils.ts';
import type { ContactMetadata, ContactRecord } from '#src/types/contact.ts';

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
  getLoggedInSignerUser: () => Promise<NostrUser>;
  ndk: NostrClient;
  resolveLoggedInPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolveLoggedInReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  updateStartupInternalTask: (
    parentStepId: 'contact-cursor-state',
    taskId: 'mute-list',
    updates: { eventCount?: number | null },
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
  loggedInPubkeyHex: string | null,
): MuteListContent {
  const blockedPubkeys = normalizeListPubkeys(content.blockedPubkeys, loggedInPubkeyHex);
  const blockedPubkeySet = new Set(blockedPubkeys);
  const mutedPubkeys = normalizeListPubkeys(content.mutedPubkeys, loggedInPubkeyHex).filter(
    (pubkey) => !blockedPubkeySet.has(pubkey),
  );

  return {
    blockedPubkeys,
    mutedPubkeys,
  };
}

function normalizeMuteTargetPubkey(
  pubkey: string,
  loggedInPubkeyHex: string | null,
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
  blockedAt: string,
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
  blockedAt: string,
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

function eventToNdkEvent(ndk: NostrClient, event: ClientEvent | NostrEvent): ClientEvent {
  return event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
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
  let mutationVersion = 0;
  let latestMuteListCreatedAt = 0;
  let sessionVersion = 0;
  let savingLocalBlock = false;

  function currentSession(): () => boolean {
    const version = sessionVersion;
    const account = getLoggedInPublicKeyHex();
    return () => version === sessionVersion && account === getLoggedInPublicKeyHex();
  }

  async function readCachedMuteListContent(): Promise<MuteListContent> {
    const [contacts, chats] = await Promise.all([
      contactsService.listContacts(),
      chatDataService.listChats(),
    ]);
    return normalizeMuteListContent(
      {
        mutedPubkeys: [
          ...contacts
            .filter((contact) => isMutedMeta(contact.meta))
            .map((contact) => contact.public_key),
          ...chats.filter((chat) => isMutedMeta(chat.meta)).map((chat) => chat.public_key),
        ],
        blockedPubkeys: [
          ...contacts
            .filter((contact) => isBlockedContactMeta(contact.meta))
            .map((contact) => contact.public_key),
          ...chats.filter((chat) => isBlockedChatMeta(chat.meta)).map((chat) => chat.public_key),
        ],
      },
      getLoggedInPublicKeyHex(),
    );
  }

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
    optionsByBlockedPubkey = new Map<string, BlockTargetOptions>(),
    pendingBlock?: { pubkey: string; blocked: boolean },
    isApplicable: () => boolean = () => true,
  ): Promise<void> {
    const isSameSession = currentSession();
    const isCurrent = () => isSameSession() && isApplicable();
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
    if (!isCurrent()) return;
    const existingContactPubkeys = new Set<string>();
    const chatByPubkey = new Map<string, ChatRow>();

    for (const chat of chats) {
      const normalizedPubkey = normalizeMuteTargetPubkey(chat.public_key, loggedInPubkeyHex);
      if (normalizedPubkey) {
        chatByPubkey.set(normalizedPubkey, chat);
      }
    }

    for (const contact of contacts) {
      if (!isCurrent()) return;
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
        now,
      );
      if (pendingBlock?.pubkey === normalizedPubkey)
        nextContactMeta.pending_block = pendingBlock.blocked;
      if (
        isMutedMeta(contactMeta) === shouldMute &&
        isBlockedContactMeta(contactMeta) === shouldBlock &&
        metadataEqual(
          contactMeta as Record<string, unknown>,
          nextContactMeta as Record<string, unknown>,
        )
      ) {
        continue;
      }

      await contactsService.updateContact(contact.id, {
        metaBase: contact.meta,
        meta: nextContactMeta,
      });
      didChangeContacts = true;
    }

    for (const blockedPubkey of blockedPubkeys) {
      if (!isCurrent()) return;
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
          ...(pendingBlock?.pubkey === blockedPubkey
            ? { pending_block: pendingBlock.blocked }
            : {}),
          ...(contactType === 'group' ? { group: true } : {}),
        },
      });

      if (createdContact) {
        didChangeContacts = true;
      }
    }

    for (const chat of chats) {
      if (!isCurrent()) return;
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
        now,
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
        if (!isCurrent()) return;
        await chatDataService.markChatAsRead(chat.public_key);
        didChangeChats = true;
      }
    }

    if (!isCurrent()) return;
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
    seedRelayUrls: string[] = [],
  ): Promise<{ content: MuteListContent; createdAt: number } | null> {
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

    const relaySet = NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
    const fetchedEvent = await fetchEventWithRelayTimeout(
      ndk,
      {
        kinds: [MUTE_LIST_KIND],
        authors: [loggedInPubkeyHex],
      },
      {
        cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
        startupTrackId: 'mute-list',
      },
      relaySet,
    );
    if (!fetchedEvent) {
      // An unfinished replica is not evidence that the existing mute list is empty.
      if (startupRelayStatuses(ndk, 'mute-list').some((relay) => relay.status !== 'success'))
        return null;
      return {
        content: { blockedPubkeys: [], mutedPubkeys: [] },
        createdAt: 0,
      };
    }

    const muteListEvent = eventToNdkEvent(ndk, fetchedEvent);
    updateStoredEventSinceFromCreatedAt(muteListEvent.created_at);
    return {
      content: await decryptMuteListContent(muteListEvent.content),
      createdAt: muteListEvent.created_at ?? 0,
    };
  }

  async function restoreMuteList(
    seedRelayUrls: string[] = [],
    syncPendingBlocks = true,
  ): Promise<void> {
    const signal = startupRelaySignal(ndk);
    const isCurrent = currentSession();
    if (restoreMuteListPromise) {
      return restoreMuteListPromise;
    }

    beginStartupStep('mute-list');
    const version = mutationVersion;
    restoreMuteListPromise = (async () => {
      try {
        if (!hasRestoredMuteList) {
          const cached = await readCachedMuteListContent();
          if (!isCurrent() || signal.aborted) return;
          if (version === mutationVersion && !savingLocalBlock) {
            mutedPubkeySet = new Set(cached.mutedPubkeys);
            blockedPubkeySet = new Set(cached.blockedPubkeys);
          }
        }
        const snapshot = await fetchMuteListContent(seedRelayUrls);
        if (signal.aborted || !isCurrent()) return;
        if (
          snapshot !== null &&
          version === mutationVersion &&
          !savingLocalBlock &&
          snapshot.createdAt >= latestMuteListCreatedAt
        ) {
          // Keep unsynced local choices through failed reads, publication and
          // reloads. Merge them into the remote list before replacing that list.
          const contacts = await contactsService.listContacts();
          if (!isCurrent() || signal.aborted || version !== mutationVersion || savingLocalBlock)
            return;
          const pending = contacts.filter(
            (contact) => typeof contact.meta.pending_block === 'boolean',
          );
          const blocked = new Set(snapshot.content.blockedPubkeys);
          for (const contact of pending) {
            if (contact.meta.pending_block) blocked.add(contact.public_key);
            else blocked.delete(contact.public_key);
          }
          const normalizedContent = normalizeMuteListContent(
            { ...snapshot.content, blockedPubkeys: [...blocked] },
            getLoggedInPublicKeyHex(),
          );
          updateMuteListStartupEntryCount(
            normalizedContent.mutedPubkeys.length + normalizedContent.blockedPubkeys.length,
          );
          await applyMuteListContent(
            normalizedContent,
            undefined,
            undefined,
            () => version === mutationVersion && !savingLocalBlock,
          );
          if (!isCurrent() || signal.aborted || version !== mutationVersion || savingLocalBlock)
            return;
          latestMuteListCreatedAt = snapshot.createdAt;
          hasRestoredMuteList = true;
          if (pending.length && syncPendingBlocks) await publishMuteList(seedRelayUrls);
        }

        completeStartupStep('mute-list');
      } catch (error) {
        if (signal.aborted || !isCurrent()) return;
        failStartupStep('mute-list', error);
        throw error;
      }
    })().finally(() => {
      if (isCurrent()) restoreMuteListPromise = null;
    });

    return restoreMuteListPromise;
  }

  async function publishMuteList(seedRelayUrls: string[] = []): Promise<void> {
    const isCurrent = currentSession();
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      throw new Error('Missing public key in localStorage. Login is required.');
    }

    const relayUrls = await resolveLoggedInPublishRelayUrls(seedRelayUrls);
    if (!isCurrent()) return;
    if (relayUrls.length === 0) {
      throw new Error('Cannot publish mute list without at least one relay.');
    }

    await ensureRelayConnections(relayUrls);
    if (!isCurrent()) return;
    const user = await getLoggedInSignerUser();
    if (!isCurrent()) return;
    const pending = (await contactsService.listContacts()).filter(
      (contact) => typeof contact.meta.pending_block === 'boolean',
    );
    if (!isCurrent()) return;
    const version = mutationVersion;
    const { mutedPubkeys, blockedPubkeys } = normalizeMuteListContent(
      {
        mutedPubkeys: Array.from(mutedPubkeySet),
        blockedPubkeys: Array.from(blockedPubkeySet),
      },
      loggedInPubkeyHex,
    );
    const muteListEvent = new ClientEvent(ndk, {
      kind: MUTE_LIST_KIND,
      created_at: Math.max(Math.floor(Date.now() / 1000), latestMuteListCreatedAt + 1),
      pubkey: user.pubkey,
      content: await encryptMuteListTags(buildMuteListTags(mutedPubkeys, blockedPubkeys)),
      tags: [],
    });

    const relaySet = NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
    if (!isCurrent()) return;
    await muteListEvent.publishReplaceable(relaySet);
    if (!isCurrent()) return;
    latestMuteListCreatedAt = Math.max(muteListEvent.created_at ?? 0, latestMuteListCreatedAt);
    updateStoredEventSinceFromCreatedAt(muteListEvent.created_at);
    hasRestoredMuteList = true;
    for (const contact of pending) {
      if (!isCurrent() || version !== mutationVersion) return;
      const meta = { ...contact.meta };
      delete meta.pending_block;
      await contactsService.updateContact(contact.id, { metaBase: contact.meta, meta });
    }
  }

  async function setPubkeyMuted(
    pubkey: string,
    muted: boolean,
    seedRelayUrls: string[] = [],
  ): Promise<void> {
    mutationVersion += 1;
    const isCurrent = currentSession();
    const mutation = muteListMutationQueue.then(async () => {
      if (!isCurrent()) return;
      if (!hasRestoredMuteList) {
        await restoreMuteList(seedRelayUrls);
      }
      if (!isCurrent()) return;

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

      latestMuteListCreatedAt = Math.max(latestMuteListCreatedAt, Math.floor(Date.now() / 1000));
      await applyMuteListContent({
        mutedPubkeys: Array.from(nextMutedPubkeys),
        blockedPubkeys: Array.from(blockedPubkeySet),
      });
      if (!isCurrent()) return;
      await publishMuteList(seedRelayUrls);
    });

    muteListMutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  async function setPubkeyBlocked(
    pubkey: string,
    blocked: boolean,
    seedRelayUrls: string[] = [],
    options: BlockTargetOptions = {},
  ): Promise<void> {
    mutationVersion += 1;
    const isCurrent = currentSession();
    const mutation = muteListMutationQueue.then(async () => {
      if (!isCurrent()) return;
      const loggedInPubkeyHex = getLoggedInPublicKeyHex();
      const normalizedPubkey = normalizeMuteTargetPubkey(pubkey, loggedInPubkeyHex);
      if (!loggedInPubkeyHex || !normalizedPubkey) {
        return;
      }
      // A startup read may fail. It must not prevent the local block from
      // taking effect, or replace other cached blocks with an empty list.
      savingLocalBlock = true;
      try {
        const cached = await readCachedMuteListContent();
        if (!isCurrent()) return;
        const nextMutedPubkeys = new Set([...cached.mutedPubkeys, ...mutedPubkeySet]);
        const nextBlockedPubkeys = new Set([...cached.blockedPubkeys, ...blockedPubkeySet]);
        if (blocked) {
          nextBlockedPubkeys.add(normalizedPubkey);
          nextMutedPubkeys.delete(normalizedPubkey);
        } else {
          nextBlockedPubkeys.delete(normalizedPubkey);
        }

        await applyMuteListContent(
          {
            mutedPubkeys: Array.from(nextMutedPubkeys),
            blockedPubkeys: Array.from(nextBlockedPubkeys),
          },
          blocked
            ? new Map<string, BlockTargetOptions>([[normalizedPubkey, options]])
            : new Map<string, BlockTargetOptions>(),
          { pubkey: normalizedPubkey, blocked },
        );
      } finally {
        if (isCurrent()) {
          savingLocalBlock = false;
          mutationVersion += 1;
        }
      }
      if (!isCurrent()) return;
      // Finish any older restore after saving locally. Its stale snapshot may
      // not overwrite the user's choice or clear its pending publication.
      await restoreMuteListPromise?.catch(() => {});
      if (!isCurrent()) return;
      if (!hasRestoredMuteList) {
        await restoreMuteList(seedRelayUrls, false);
        if (!isCurrent()) return;
        if (!hasRestoredMuteList)
          throw new Error('Saved on this device. Could not sync the block list.');
      }
      await publishMuteList(seedRelayUrls);
    });

    muteListMutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  function resetMuteListRuntimeState(): void {
    sessionVersion += 1;
    savingLocalBlock = false;
    mutationVersion += 1;
    latestMuteListCreatedAt = 0;
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
