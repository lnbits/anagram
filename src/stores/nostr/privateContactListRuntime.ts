import NostrClient, {
  ClientEvent,
  type NostrFilter,
  NostrKind,
  NostrRelaySet,
  NostrSubscriptionCacheUsage,
  type NostrSubscriptionOptions,
  type NostrUser,
} from '#src/lib/nostr/client.ts';
import { type ChatRow, chatDataService, type MessageRow } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { PRIVATE_CONTACT_LIST_D_TAG, PRIVATE_CONTACT_LIST_TITLE } from '#src/stores/nostr/constants.ts';
import {
  createDesiredSubscriptions,
  subscriptionSignature,
} from '#src/stores/nostr/desiredSubscriptions.ts';
import { createReadyRelaySet, fetchEventWithRelayTimeout } from '#src/stores/nostr/relayQueryUtils.ts';
import type { Ref } from '#src/lib/state/reactivity.ts';

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
    event: Pick<ClientEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
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
  extractRelayUrlsFromEvent: (event: ClientEvent) => string[];
  failStartupStep: (stepId: 'private-contact-list', error: unknown) => void;
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getLoggedInPublicKeyHex: () => string | null;
  getLoggedInSignerUser: () => Promise<NostrUser>;
  getStartupStepSnapshot: (stepId: 'private-contact-list') => { status: string };
  isRestoringStartupState: Ref<boolean>;
  logSubscription: (label: string, stage: string, details?: Record<string, unknown>) => void;
  markPrivateContactListEventApplied: (event: Pick<ClientEvent, 'created_at' | 'id'>) => void;
  ndk: NostrClient;
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
  shouldApplyPrivateContactListEvent: (event: ClientEvent) => boolean;
  subscribeWithReqLogging: (
    label: string,
    requestLabel: string,
    filters: NostrFilter | NostrFilter[],
    options: NostrSubscriptionOptions & {
      onEvent?: (event: ClientEvent) => void;
      onEose?: () => void;
      onClose?: () => void;
    },
    details?: Record<string, unknown>
  ) => ReturnType<NostrClient['subscribe']>;
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
  buildSubscriptionRelayDetails,
  chatStore,
  completeStartupStep,
  createStartupBatchTracker,
  decryptPrivateContactListContent,
  encryptPrivateContactListTags,
  ensureContactListedInPrivateContactList,
  ensureRelayConnections,
  failStartupStep,
  getLoggedInPublicKeyHex,
  getLoggedInSignerUser,
  getStartupStepSnapshot,
  isRestoringStartupState,
  logSubscription,
  markPrivateContactListEventApplied,
  ndk,
  queueTrackedContactSubscriptionsRefresh,
  reconcileAcceptedChatFromPrivateContactList,
  resolvePrivateContactListPublishRelayUrls,
  resolvePrivateContactListReadRelayUrls,
  shouldApplyPrivateContactListEvent,
  subscribeWithReqLogging,
  updateStoredEventSinceFromCreatedAt,
  updateStartupStep,
}: PrivateContactListRuntimeDeps) {
  let restorePrivateContactListPromise: Promise<void> | null = null;
  let privateContactListSubscription: ReturnType<NostrClient['subscribe']> | null = null;
  let privateContactListSubscriptionSignature = '';
  const desiredSubscriptions = createDesiredSubscriptions();
  let generation = 0;
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
    let didChange = false;

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
        didChange = true;
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
      didChange ||= ensuredContactResult.didChange;

      await reconcileAcceptedChatFromPrivateContactList(target.publicKey);
    }

    profileTracker?.seal();
    relayTracker?.seal();

    if (didChange) bumpContactListVersion();
    if (didChange && !isRestoringStartupState.value) {
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
    event: ClientEvent,
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

  async function applyPrivateContactListEvent(event: ClientEvent): Promise<void> {
    if (!shouldApplyPrivateContactListEvent(event)) {
      return;
    }

    const pubkeys = await decryptPrivateContactListContent(event.content);
    updatePrivateContactListStartupEntryCount(countPrivateContactListEntries(pubkeys));
    await applyPrivateContactListPubkeys(pubkeys);
    markPrivateContactListEventApplied(event);
  }

  function queuePrivateContactListEventApplication(event: ClientEvent): void {
    const runGeneration = generation;
    privateContactListApplyQueue = privateContactListApplyQueue
      .then(() => {
        if (runGeneration === generation) return applyPrivateContactListEvent(event);
      })
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

      const listEvent = new ClientEvent(ndk, {
        kind: NostrKind.FollowSet,
        created_at: Math.floor(Date.now() / 1000),
        pubkey: user.pubkey,
        content: await encryptPrivateContactListTags(buildPrivateContactListTags(pubkeys)),
        tags: [
          ['d', PRIVATE_CONTACT_LIST_D_TAG],
          ['title', PRIVATE_CONTACT_LIST_TITLE],
        ],
      });

      const relaySet = NostrRelaySet.fromRelayUrls(relayUrls, ndk, false);
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
    let listEvent: ClientEvent | null = null;

    if (relayUrls.length > 0) {
      await ensureRelayConnections(relayUrls);
      await getLoggedInSignerUser();

      const relaySet = createReadyRelaySet(ndk, relayUrls);
      const fetchedEvent = await fetchEventWithRelayTimeout(
        ndk,
        {
          kinds: [NostrKind.FollowSet],
          authors: [loggedInPubkeyHex],
          '#d': [PRIVATE_CONTACT_LIST_D_TAG],
        },
        {
          cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
        },
        relaySet
      );
      listEvent =
        fetchedEvent instanceof ClientEvent
          ? fetchedEvent
          : fetchedEvent
            ? new ClientEvent(ndk, fetchedEvent)
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
        await subscribePrivateContactListUpdates(seedRelayUrls);
        await desiredSubscriptions.waitForEose();
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
    generation += 1;
    desiredSubscriptions.stop();
    if (privateContactListSubscription) {
      logSubscription('private-contact-list', 'stop', {
        reason,
        signature: privateContactListSubscriptionSignature || null,
      });
      privateContactListSubscription = null;
    }

    privateContactListSubscriptionSignature = '';
  }

  async function subscribePrivateContactListUpdates(
    seedRelayUrls: string[] = [],
    _force = false
  ): Promise<void> {
    const runGeneration = generation;
    const pubkey = getLoggedInPublicKeyHex();
    if (!pubkey) {
      desiredSubscriptions.stop();
      return;
    }
    const relayUrls = await resolvePrivateContactListReadRelayUrls(seedRelayUrls);
    if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
    if (!relayUrls.length) {
      desiredSubscriptions.stop();
      return;
    }
    const filters: NostrFilter = {
      kinds: [NostrKind.FollowSet],
      authors: [pubkey],
      '#d': [PRIVATE_CONTACT_LIST_D_TAG],
    };
    const signature = subscriptionSignature(filters, relayUrls);
    await desiredSubscriptions.reconcile([
      {
        key: 'private-contact-list',
        signature,
        prepare: async () => {
          await ensureRelayConnections(relayUrls);
          await getLoggedInSignerUser();
        },
        applied: () => privateContactListApplyQueue,
        start: (onEose, onClose) => {
          privateContactListSubscriptionSignature = signature;
          privateContactListSubscription = subscribeWithReqLogging(
            'private-contact-list',
            'private-contact-list',
            filters,
            {
              relaySet: NostrRelaySet.fromRelayUrls(relayUrls, ndk, false),
              cacheUsage: NostrSubscriptionCacheUsage.ONLY_RELAY,
              onEvent: (event) => {
                if (runGeneration !== generation || pubkey !== getLoggedInPublicKeyHex()) return;
                const wrappedEvent = event instanceof ClientEvent ? event : new ClientEvent(ndk, event);
                updateStoredEventSinceFromCreatedAt(wrappedEvent.created_at);
                queuePrivateContactListEventApplication(wrappedEvent);
              },
              onEose,
              onClose,
            },
            { signature, ...buildSubscriptionRelayDetails(relayUrls) }
          );
          return privateContactListSubscription;
        },
      },
    ]);
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
