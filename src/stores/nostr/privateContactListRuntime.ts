import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKKind,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKSubscriptionOptions,
  type NDKUser,
} from '@nostr-dev-kit/ndk';
import { type ChatRow, chatDataService, type MessageRow } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { PRIVATE_CONTACT_LIST_D_TAG, PRIVATE_CONTACT_LIST_TITLE } from 'src/stores/nostr/constants';
import { createReadyRelaySet, fetchEventWithRelayTimeout } from 'src/stores/nostr/relayQueryUtils';
import type { Ref } from 'vue';

interface PrivateContactListTarget {
  publicKey: string;
  fallbackName?: string;
  type?: 'user' | 'group';
}

interface PrivateContactListRuntimeDeps {
  beginStartupStep: (stepId: 'private-contact-list') => void;
  bumpContactListVersion: () => void;
  buildPrivateContactListTags: (pubkeys: string[]) => string[][];
  buildSubscriptionEventDetails: (
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ) => Record<string, unknown>;
  buildSubscriptionRelayDetails: (relayUrls: string[]) => Record<string, unknown>;
  chatStore: { init: () => Promise<void> };
  completeStartupStep: (stepId: 'private-contact-list') => void;
  createStartupBatchTracker: (stepId: 'private-contact-profiles' | 'private-contact-relays') => {
    beginItem: () => void;
    finishItem: (error?: unknown) => void;
    seal: () => void;
  };
  decryptPrivateContactListContent: (content: string) => Promise<string[]>;
  encryptPrivateContactListTags: (tags: string[][]) => Promise<string>;
  ensureContactListedInPrivateContactList: (
    targetPubkeyHex: string,
    options?: {
      fallbackName?: string;
      type?: 'user' | 'group';
    }
  ) => Promise<{
    contact: { name?: string | null } | null;
    didChange: boolean;
  }>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  extractRelayUrlsFromEvent: (event: NDKEvent) => string[];
  failStartupStep: (stepId: 'private-contact-list', error: unknown) => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getFilterSince: () => number;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NDKUser>;
  getStartupStepSnapshot: (stepId: 'private-contact-list') => { status: string };
  isRestoringStartupState: Ref<boolean>;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  markPrivateContactListEventApplied: (event: Pick<NDKEvent, 'created_at' | 'id'>) => void;
  ndk: NDK;
  queueTrackedContactSubscriptionsRefresh: (seedRelayUrls?: string[], force?: boolean) => void;
  reconcileAcceptedChatFromPrivateContactList: (contactPublicKey: string) => Promise<void>;
  refreshContactByPublicKey: (
    pubkeyHex: string,
    fallbackName?: string,
    lifecycle?: Record<string, unknown>
  ) => Promise<unknown>;
  relaySignature: (relays: string[]) => string;
  resolvePrivateContactListPublishRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  resolvePrivateContactListReadRelayUrls: (seedRelayUrls?: string[]) => Promise<string[]>;
  shouldApplyPrivateContactListEvent: (event: NDKEvent) => boolean;
  subscribeWithReqLogging: (
    label: string,
    requestLabel: string,
    filters: NDKFilter | NDKFilter[],
    options: NDKSubscriptionOptions & {
      onEvent?: (event: NDKEvent) => void;
      onEose?: () => void;
      onClose?: () => void;
    },
    details?: Record<string, unknown>
  ) => ReturnType<NDK['subscribe']>;
  updateStoredEventSinceFromCreatedAt: (value: unknown) => void;
  updateStartupStep: (
    stepId: 'private-contact-list-restore',
    updates: { eventCount?: number | null; label?: string }
  ) => void;
}

export function createPrivateContactListRuntime({
  beginStartupStep,
  bumpContactListVersion,
  buildPrivateContactListTags,
  buildSubscriptionEventDetails,
  buildSubscriptionRelayDetails,
  chatStore,
  completeStartupStep,
  createStartupBatchTracker,
  decryptPrivateContactListContent,
  encryptPrivateContactListTags,
  ensureContactListedInPrivateContactList,
  ensureRelayConnections,
  extractRelayUrlsFromEvent,
  failStartupStep,
  formatSubscriptionLogValue,
  getFilterSince,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  getStartupStepSnapshot,
  isRestoringStartupState,
  logSubscription,
  markPrivateContactListEventApplied,
  ndk,
  queueTrackedContactSubscriptionsRefresh,
  reconcileAcceptedChatFromPrivateContactList,
  refreshContactByPublicKey,
  relaySignature,
  resolvePrivateContactListPublishRelayUrls,
  resolvePrivateContactListReadRelayUrls,
  shouldApplyPrivateContactListEvent,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
  updateStartupStep,
}: PrivateContactListRuntimeDeps) {
  let restorePrivateContactListPromise: Promise<void> | null = null;
  let privateContactListSubscription: ReturnType<NDK['subscribe']> | null = null;
  let privateContactListSubscriptionSignature = '';
  let privateContactListApplyQueue = Promise.resolve();

  function normalizePrivateContactListTargets(
    targets: PrivateContactListTarget[]
  ): PrivateContactListTarget[] {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const targetsByPubkey = new Map<string, PrivateContactListTarget>();

    for (const target of targets) {
      const normalizedPubkey = inputSanitizerService.normalizeHexKey(target.publicKey);
      if (!normalizedPubkey || normalizedPubkey === loggedInPubkeyHex) {
        continue;
      }

      const existingTarget = targetsByPubkey.get(normalizedPubkey);
      const fallbackName = target.fallbackName?.trim() || existingTarget?.fallbackName;
      const type = target.type ?? existingTarget?.type;
      targetsByPubkey.set(normalizedPubkey, {
        publicKey: normalizedPubkey,
        ...(fallbackName ? { fallbackName } : {}),
        ...(type ? { type } : {}),
      });
    }

    return Array.from(targetsByPubkey.values());
  }

  function buildPrivateContactListTargetsFromPubkeys(
    pubkeys: string[]
  ): PrivateContactListTarget[] {
    return normalizePrivateContactListTargets(
      pubkeys.map((pubkey) => ({
        publicKey: pubkey,
      }))
    );
  }

  function countPrivateContactListEntries(pubkeys: string[]): number {
    return buildPrivateContactListTargetsFromPubkeys(pubkeys).length;
  }

  function updatePrivateContactListStartupEntryCount(entryCount: number): void {
    if (getStartupStepSnapshot('private-contact-list').status !== 'in_progress') {
      return;
    }

    updateStartupStep('private-contact-list-restore', {
      eventCount: Math.max(0, Math.floor(entryCount)),
    });
  }

  function isMutedOrBlockedChat(chat: ChatRow): boolean {
    const meta = chat.meta && typeof chat.meta === 'object' ? chat.meta : {};
    return (
      meta.muted === true ||
      meta.inbox_state === 'blocked' ||
      (typeof meta.blocked_at === 'string' && meta.blocked_at.trim().length > 0)
    );
  }

  function listOutgoingMessageContactTargetsFromRows(
    chats: ChatRow[],
    messages: MessageRow[]
  ): PrivateContactListTarget[] {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return [];
    }

    const candidateChatsByPubkey = new Map<string, ChatRow>();
    for (const chat of chats) {
      const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(chat.public_key);
      if (
        !normalizedChatPubkey ||
        normalizedChatPubkey === loggedInPubkeyHex ||
        isMutedOrBlockedChat(chat)
      ) {
        continue;
      }

      candidateChatsByPubkey.set(normalizedChatPubkey, chat);
    }

    const targetsByPubkey = new Map<string, PrivateContactListTarget>();
    for (const message of messages) {
      const normalizedAuthorPubkey = inputSanitizerService.normalizeHexKey(
        message.author_public_key
      );
      if (normalizedAuthorPubkey !== loggedInPubkeyHex) {
        continue;
      }

      const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(message.chat_public_key);
      if (!normalizedChatPubkey || targetsByPubkey.has(normalizedChatPubkey)) {
        continue;
      }

      const chat = candidateChatsByPubkey.get(normalizedChatPubkey);
      if (!chat) {
        continue;
      }

      const fallbackName = chat.name.trim() || normalizedChatPubkey.slice(0, 16);
      targetsByPubkey.set(normalizedChatPubkey, {
        publicKey: normalizedChatPubkey,
        fallbackName,
        type: chat.type === 'group' ? 'group' : 'user',
      });
    }

    return Array.from(targetsByPubkey.values());
  }

  async function listOutgoingMessageContactTargets(): Promise<PrivateContactListTarget[]> {
    await chatDataService.init();
    const [chats, messages] = await Promise.all([
      chatDataService.listChats(),
      chatDataService.listAllMessages(),
    ]);

    return listOutgoingMessageContactTargetsFromRows(chats, messages);
  }

  function listNewPrivateContactListTargets(
    targets: PrivateContactListTarget[],
    existingPubkeys: Set<string>
  ): PrivateContactListTarget[] {
    return normalizePrivateContactListTargets(targets).filter(
      (target) => !existingPubkeys.has(target.publicKey)
    );
  }

  async function applyPrivateContactListTargets(
    targets: PrivateContactListTarget[],
    options: { deleteMissingContacts?: boolean } = {}
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const normalizedTargets = normalizePrivateContactListTargets(targets);
    await Promise.all([contactsService.init(), chatDataService.init(), chatStore.init()]);
    const shouldTrackStartupSteps =
      isRestoringStartupState.value ||
      getStartupStepSnapshot('private-contact-list').status === 'in_progress';
    const profileTracker = shouldTrackStartupSteps
      ? createStartupBatchTracker('private-contact-profiles')
      : null;
    const relayTracker = shouldTrackStartupSteps
      ? createStartupBatchTracker('private-contact-relays')
      : null;

    const nextPubkeys = new Set(normalizedTargets.map((target) => target.publicKey));
    const existingContacts = await contactsService.listContacts();

    if (options.deleteMissingContacts !== false) {
      for (const contact of existingContacts) {
        const normalizedPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
        if (!normalizedPubkey || normalizedPubkey === loggedInPubkeyHex) {
          continue;
        }

        if (nextPubkeys.has(normalizedPubkey)) {
          continue;
        }

        await contactsService.deleteContact(contact.id);
      }
    }

    for (const target of normalizedTargets) {
      const existingContact = await contactsService.getContactByPublicKey(target.publicKey);
      const ensuredContactResult = await ensureContactListedInPrivateContactList(target.publicKey, {
        fallbackName:
          target.fallbackName?.trim() ||
          existingContact?.name?.trim() ||
          target.publicKey.slice(0, 16),
        ...(target.type ? { type: target.type } : {}),
      });
      const fallbackName =
        ensuredContactResult.contact?.name?.trim() ||
        target.fallbackName?.trim() ||
        existingContact?.name?.trim() ||
        target.publicKey.slice(0, 16);
      try {
        await refreshContactByPublicKey(target.publicKey, fallbackName, {
          onProfileFetchStart: () => {
            profileTracker?.beginItem();
          },
          onProfileFetchEnd: (error?: unknown) => {
            profileTracker?.finishItem(error ?? undefined);
          },
          onRelayFetchStart: () => {
            relayTracker?.beginItem();
          },
          onRelayFetchEnd: (error?: unknown) => {
            relayTracker?.finishItem(error ?? undefined);
          },
        });
      } catch (error) {
        profileTracker?.finishItem(error);
        relayTracker?.finishItem(error);
        console.warn('Failed to refresh private contact list profile', target.publicKey, error);
      }

      await reconcileAcceptedChatFromPrivateContactList(target.publicKey);
    }

    profileTracker?.seal();
    relayTracker?.seal();

    bumpContactListVersion();
    if (!isRestoringStartupState.value) {
      queueTrackedContactSubscriptionsRefresh();
    }
  }

  async function applyPrivateContactListPubkeys(pubkeys: string[]): Promise<void> {
    await applyPrivateContactListTargets(buildPrivateContactListTargetsFromPubkeys(pubkeys));
  }

  async function applyOutgoingMessageContactAdditions(
    outgoingTargets: PrivateContactListTarget[],
    seedRelayUrls: string[] = []
  ): Promise<void> {
    if (outgoingTargets.length === 0) {
      return;
    }

    await contactsService.init();
    const existingContacts = await contactsService.listContacts();
    const existingPubkeys = new Set(
      existingContacts
        .map((contact) => inputSanitizerService.normalizeHexKey(contact.public_key))
        .filter((pubkey): pubkey is string => Boolean(pubkey))
    );
    const newTargets = listNewPrivateContactListTargets(outgoingTargets, existingPubkeys);
    if (newTargets.length === 0) {
      return;
    }

    await applyPrivateContactListTargets(newTargets, {
      deleteMissingContacts: false,
    });
    await publishPrivateContactList(seedRelayUrls);
  }

  async function applyPrivateContactListEventWithOutgoingTargets(
    event: NDKEvent,
    outgoingTargets: PrivateContactListTarget[],
    seedRelayUrls: string[] = []
  ): Promise<void> {
    if (!shouldApplyPrivateContactListEvent(event)) {
      await applyOutgoingMessageContactAdditions(outgoingTargets, seedRelayUrls);
      return;
    }

    const pubkeys = await decryptPrivateContactListContent(event.content);
    const restoredTargets = buildPrivateContactListTargetsFromPubkeys(pubkeys);
    const restoredPubkeys = new Set(restoredTargets.map((target) => target.publicKey));
    const outgoingAdditions = listNewPrivateContactListTargets(outgoingTargets, restoredPubkeys);
    const mergedTargets = normalizePrivateContactListTargets([
      ...restoredTargets,
      ...outgoingTargets,
    ]);

    await applyPrivateContactListTargets(mergedTargets);
    markPrivateContactListEventApplied(event);

    if (outgoingAdditions.length > 0) {
      await publishPrivateContactList(seedRelayUrls);
    }
  }

  async function applyPrivateContactListEvent(event: NDKEvent): Promise<void> {
    if (!shouldApplyPrivateContactListEvent(event)) {
      return;
    }

    const pubkeys = await decryptPrivateContactListContent(event.content);
    updatePrivateContactListStartupEntryCount(countPrivateContactListEntries(pubkeys));
    await applyPrivateContactListPubkeys(pubkeys);
    markPrivateContactListEventApplied(event);
  }

  function queuePrivateContactListEventApplication(event: NDKEvent): void {
    privateContactListApplyQueue = privateContactListApplyQueue
      .then(() => applyPrivateContactListEvent(event))
      .catch((error) => {
        console.error('Failed to process private contact list event', error);
      });
  }

  async function publishPrivateContactList(seedRelayUrls: string[] = []): Promise<void> {
    try {
      const loggedInPubkeyHex = getLoggedInPublicKeyHex();
      if (!loggedInPubkeyHex) {
        throw new Error('Missing public key in localStorage. Login is required.');
      }

      const relayUrls = await resolvePrivateContactListPublishRelayUrls(seedRelayUrls);
      if (relayUrls.length === 0) {
        throw new Error('Cannot publish private contact list without at least one relay.');
      }

      await ensureRelayConnections(relayUrls);

      await contactsService.init();
      const contacts = await contactsService.listContacts();
      const pubkeys = contacts
        .map((contact) => inputSanitizerService.normalizeHexKey(contact.public_key))
        .filter((pubkey): pubkey is string => Boolean(pubkey) && pubkey !== loggedInPubkeyHex);
      const user = await getLoggedInSignerUser();

      const listEvent = new NDKEvent(ndk, {
        kind: NDKKind.FollowSet,
        created_at: Math.floor(Date.now() / 1000),
        pubkey: user.pubkey,
        content: await encryptPrivateContactListTags(buildPrivateContactListTags(pubkeys)),
        tags: [
          ['d', PRIVATE_CONTACT_LIST_D_TAG],
          ['title', PRIVATE_CONTACT_LIST_TITLE],
        ],
      });

      const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
      await listEvent.publishReplaceable(relaySet);
      updateStoredEventSinceFromCreatedAt(listEvent.created_at);
      markPrivateContactListEventApplied(listEvent);
    } finally {
      queueTrackedContactSubscriptionsRefresh(seedRelayUrls);
    }
  }

  async function refreshPrivateContactListWithOutgoingMessages(
    seedRelayUrls: string[] = []
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return;
    }

    const outgoingTargets = await listOutgoingMessageContactTargets();
    const relayUrls = await resolvePrivateContactListReadRelayUrls(seedRelayUrls);
    let listEvent: NDKEvent | null = null;

    if (relayUrls.length > 0) {
      await ensureRelayConnections(relayUrls);
      await getLoggedInSignerUser();

      const relaySet = createReadyRelaySet(ndk, relayUrls);
      const fetchedEvent = await fetchEventWithRelayTimeout(
        ndk,
        {
          kinds: [NDKKind.FollowSet],
          authors: [loggedInPubkeyHex],
          '#d': [PRIVATE_CONTACT_LIST_D_TAG],
        },
        {
          cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        },
        relaySet
      );
      listEvent =
        fetchedEvent instanceof NDKEvent
          ? fetchedEvent
          : fetchedEvent
            ? new NDKEvent(ndk, fetchedEvent)
            : null;
    }

    if (!listEvent) {
      await applyOutgoingMessageContactAdditions(outgoingTargets, seedRelayUrls);
      return;
    }

    updateStoredEventSinceFromCreatedAt(listEvent.created_at);
    await applyPrivateContactListEventWithOutgoingTargets(
      listEvent,
      outgoingTargets,
      seedRelayUrls
    );
  }

  async function restorePrivateContactList(seedRelayUrls: string[] = []): Promise<void> {
    if (restorePrivateContactListPromise) {
      return restorePrivateContactListPromise;
    }

    beginStartupStep('private-contact-list');
    updatePrivateContactListStartupEntryCount(0);
    restorePrivateContactListPromise = (async () => {
      try {
        const loggedInPubkeyHex = getLoggedInPublicKeyHex();
        if (!loggedInPubkeyHex) {
          completeStartupStep('private-contact-list');
          return;
        }

        const relayUrls = await resolvePrivateContactListReadRelayUrls(seedRelayUrls);
        if (relayUrls.length === 0) {
          completeStartupStep('private-contact-list');
          return;
        }

        await ensureRelayConnections(relayUrls);
        await getLoggedInSignerUser();

        const relaySet = createReadyRelaySet(ndk, relayUrls);
        const listEvent = await fetchEventWithRelayTimeout(
          ndk,
          {
            kinds: [NDKKind.FollowSet],
            authors: [loggedInPubkeyHex],
            '#d': [PRIVATE_CONTACT_LIST_D_TAG],
            since: getFilterSince(),
          },
          {
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
          },
          relaySet
        );
        if (!listEvent) {
          completeStartupStep('private-contact-list');
          return;
        }

        updateStoredEventSinceFromCreatedAt(listEvent.created_at);
        await applyPrivateContactListEvent(
          listEvent instanceof NDKEvent ? listEvent : new NDKEvent(ndk, listEvent)
        );
        completeStartupStep('private-contact-list');
      } catch (error) {
        failStartupStep('private-contact-list', error);
        throw error;
      }
    })().finally(() => {
      restorePrivateContactListPromise = null;
    });

    return restorePrivateContactListPromise;
  }

  function stopPrivateContactListSubscription(reason = 'replace'): void {
    if (privateContactListSubscription) {
      logSubscription('private-contact-list', 'stop', {
        reason,
        signature: privateContactListSubscriptionSignature || null,
      });
      privateContactListSubscription.stop();
      privateContactListSubscription = null;
    }

    privateContactListSubscriptionSignature = '';
  }

  async function subscribePrivateContactListUpdates(
    seedRelayUrls: string[] = [],
    force = false
  ): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      stopPrivateContactListSubscription('missing-login');
      return;
    }

    const relayUrls = await resolvePrivateContactListReadRelayUrls(seedRelayUrls);
    if (relayUrls.length === 0) {
      stopPrivateContactListSubscription('no-relays');
      return;
    }

    const signature = `${loggedInPubkeyHex}:${relaySignature(relayUrls)}`;
    if (
      !force &&
      privateContactListSubscription &&
      privateContactListSubscriptionSignature === signature
    ) {
      logSubscription('private-contact-list', 'skip', {
        reason: 'already-active',
        signature,
        pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
        ...buildSubscriptionRelayDetails(relayUrls),
      });
      return;
    }

    logSubscription('private-contact-list', 'prepare', {
      force,
      signature,
      pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
    });

    await ensureRelayConnections(relayUrls);
    await getLoggedInSignerUser();
    stopPrivateContactListSubscription();

    logSubscription('private-contact-list', 'start', {
      force,
      signature,
      pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
      subscriptionTargetType: 'user',
      userTargetCount: 1,
      userTargetPubkeys: [formatSubscriptionLogValue(loggedInPubkeyHex)],
      since: getFilterSince(),
      ...buildSubscriptionRelayDetails(relayUrls),
    });

    const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk, false);
    const privateContactListFilters: NDKFilter = {
      kinds: [NDKKind.FollowSet],
      authors: [loggedInPubkeyHex],
      '#d': [PRIVATE_CONTACT_LIST_D_TAG],
      since: getFilterSince(),
    };
    privateContactListSubscription = subscribeWithReqLogging(
      'private-contact-list',
      'private-contact-list',
      privateContactListFilters,
      {
        relaySet,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        onEvent: (event) => {
          const wrappedEvent = event instanceof NDKEvent ? event : new NDKEvent(ndk, event);
          logSubscription('private-contact-list', 'event', {
            signature,
            ...buildSubscriptionEventDetails(wrappedEvent),
            ...buildSubscriptionRelayDetails(extractRelayUrlsFromEvent(wrappedEvent)),
          });
          updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
          queuePrivateContactListEventApplication(wrappedEvent);
        },
        onEose: () => {
          logSubscription('private-contact-list', 'eose', {
            signature,
          });
        },
      },
      {
        signature,
        ...buildSubscriptionRelayDetails(relayUrls),
      }
    );
    privateContactListSubscriptionSignature = signature;

    logSubscription('private-contact-list', 'active', {
      signature,
      pubkey: formatSubscriptionLogValue(loggedInPubkeyHex),
      ...buildSubscriptionRelayDetails(relayUrls),
    });
  }

  function resetPrivateContactListRuntimeState(reason = 'replace'): void {
    stopPrivateContactListSubscription(reason);
    restorePrivateContactListPromise = null;
    privateContactListApplyQueue = Promise.resolve();
  }

  return {
    publishPrivateContactList,
    refreshPrivateContactListWithOutgoingMessages,
    resetPrivateContactListRuntimeState,
    restorePrivateContactList,
    stopPrivateContactListSubscription,
    subscribePrivateContactListUpdates,
  };
}
