import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY } from 'src/stores/nostr/constants';
import type { DeveloperDiagnosticsSnapshot } from 'src/stores/nostr/types';
import type { MessageAttachmentMetadata } from 'src/types/chat';
import { saveBrowserNotificationsPreference } from 'src/utils/browserNotificationPreference';

export interface AppE2EBootstrapOptions {
  privateKey: string;
  relayUrls: string[];
  developerDiagnosticsEnabled?: boolean;
}

export interface AppE2ERefreshOptions {
  chatId?: string | null;
}

export interface AppE2EPrivateMessagesLiveReconnectOptions {
  forceRecreate?: boolean;
}

export interface AppE2ERotateGroupEpochOptions {
  groupPublicKey: string;
  memberPublicKeys: string[];
  relayUrls?: string[];
}

export interface AppE2EUpdateContactRelaysOptions {
  publicKey: string;
  relayUrls: string[];
}

export interface AppE2EContactListMemberOptions {
  publicKey: string;
}

export interface AppE2EReplaceStoredGroupMembersOptions {
  groupPublicKey: string;
  memberPublicKeys: string[];
}

export interface AppE2ERemoveStoredMessageOptions {
  chatId: string;
  eventId: string;
}

export interface AppE2ESetStoredMessageAttachmentsOptions {
  chatId: string;
  messageText: string;
  attachments: MessageAttachmentMetadata[];
}

export interface AppE2ESendMessagesOptions {
  chatId: string;
  texts: string[];
  createdAts?: string[];
}

export interface AppE2ESentMessageSnapshot {
  id: string;
  chatId: string;
  text: string;
  sentAt: string;
  authorPublicKey: string;
  eventId: string | null;
}

export interface AppE2ESessionSnapshot {
  publicKey: string;
  npub: string | null;
  relayUrls: string[];
}

export interface AppE2EWaitForAppReadyOptions {
  contactPublicKey?: string | null;
  timeoutMs?: number;
}

export interface AppE2EBridge {
  bootstrapSession(options: AppE2EBootstrapOptions): Promise<AppE2ESessionSnapshot>;
  getDeveloperDiagnosticsSnapshot(): Promise<DeveloperDiagnosticsSnapshot>;
  getSessionSnapshot(): Promise<AppE2ESessionSnapshot>;
  isPrivateContactListMember(options: AppE2EContactListMemberOptions): Promise<boolean>;
  refreshSession(options?: AppE2ERefreshOptions): Promise<void>;
  refreshPrivateMessagesLiveReconnect(
    options?: AppE2EPrivateMessagesLiveReconnectOptions
  ): Promise<DeveloperDiagnosticsSnapshot>;
  logout(): Promise<void>;
  removeStoredMessageByEventId(options: AppE2ERemoveStoredMessageOptions): Promise<boolean>;
  setStoredMessageAttachments(options: AppE2ESetStoredMessageAttachmentsOptions): Promise<void>;
  startManualReconnectHealing(): void;
  isReconnectHealing(): Promise<boolean>;
  rotateGroupEpoch(options: AppE2ERotateGroupEpochOptions): Promise<void>;
  sendMessages(options: AppE2ESendMessagesOptions): Promise<AppE2ESentMessageSnapshot[]>;
  replaceStoredGroupMembers(options: AppE2EReplaceStoredGroupMembersOptions): Promise<void>;
  updateContactRelays(options: AppE2EUpdateContactRelaysOptions): Promise<void>;
  waitForAppReady(options?: AppE2EWaitForAppReadyOptions): Promise<void>;
}

const WINDOW_BRIDGE_KEY = '__appE2E__';
const E2E_BOOTSTRAP_RETRY_DELAYS_MS = [300, 600, 1_000];

function normalizeRelayUrls(relayUrls: string[]): string[] {
  return inputSanitizerService.normalizeRelayEntriesFromUrls(relayUrls).map((entry) => entry.url);
}

function createSessionSnapshot(
  publicKey: string,
  encodeNpub: (publicKeyHex: string) => string | null,
  relayUrls: string[]
): AppE2ESessionSnapshot {
  const normalizedRelayUrls = Array.isArray(relayUrls)
    ? relayUrls.filter((url): url is string => typeof url === 'string')
    : [];

  return JSON.parse(
    JSON.stringify({
      publicKey,
      npub: encodeNpub(publicKey),
      relayUrls: normalizedRelayUrls,
    })
  );
}

function getBootstrapErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isRetryableBootstrapError(error: unknown): boolean {
  return getBootstrapErrorMessage(error).includes('Not enough relays received the event');
}

async function waitForBootstrapRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function waitForPrivateMessagesSubscriptionEose(
  nostrStore: {
    privateMessagesSubscriptionLastEoseAt: string | null;
    waitForPrivateMessagesIngestQueue?: () => Promise<void>;
  },
  previousEoseAt: string | null,
  timeoutMs = 5_000
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;

  while (Date.now() < deadlineAt) {
    const nextEoseAt = nostrStore.privateMessagesSubscriptionLastEoseAt ?? null;
    if (nextEoseAt && nextEoseAt !== previousEoseAt) {
      await nostrStore.waitForPrivateMessagesIngestQueue?.();
      return;
    }

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 100);
    });
  }

  await nostrStore.waitForPrivateMessagesIngestQueue?.();
}

async function waitForGroupChatWithEpoch(
  chatStore: {
    chats: Array<{
      id: string;
      publicKey: string;
      type: 'user' | 'group';
      epochPublicKey: string | null;
    }>;
    reload: () => Promise<void>;
  },
  chatId: string,
  fallbackChat: {
    id: string;
    publicKey: string;
    type: 'user' | 'group';
    epochPublicKey: string | null;
  },
  timeoutMs = 5_000
): Promise<typeof fallbackChat> {
  const deadlineAt = Date.now() + timeoutMs;

  while (Date.now() < deadlineAt) {
    await chatStore.reload();
    const refreshedChat = chatStore.chats.find((entry) => entry.id === chatId) ?? fallbackChat;
    if (refreshedChat.type !== 'group' || refreshedChat.epochPublicKey) {
      return refreshedChat;
    }

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 100);
    });
  }

  await chatStore.reload();
  return chatStore.chats.find((entry) => entry.id === chatId) ?? fallbackChat;
}

async function bootstrapSession(options: AppE2EBootstrapOptions): Promise<AppE2ESessionSnapshot> {
  const privateKey = options.privateKey.trim();
  const relayUrls = normalizeRelayUrls(options.relayUrls);

  if (!privateKey) {
    throw new Error('A private key is required for e2e bootstrap.');
  }

  if (relayUrls.length === 0) {
    throw new Error('At least one relay URL is required for e2e bootstrap.');
  }

  const relayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(relayUrls);
  const [
    { useNostrStore },
    { useRelayStore },
    { useNip65RelayStore },
    { useChatStore },
    { useMessageStore },
  ] = await Promise.all([
    import('src/stores/nostrStore'),
    import('src/stores/relayStore'),
    import('src/stores/nip65RelayStore'),
    import('src/stores/chatStore'),
    import('src/stores/messageStore'),
  ]);

  const nostrStore = useNostrStore();
  const relayStore = useRelayStore();
  const nip65RelayStore = useNip65RelayStore();
  const chatStore = useChatStore();
  const messageStore = useMessageStore();

  relayStore.init();
  relayStore.replaceRelayEntries(relayEntries);

  nip65RelayStore.init();
  nip65RelayStore.replaceRelayEntries(relayEntries);

  saveBrowserNotificationsPreference(false);

  if (typeof options.developerDiagnosticsEnabled === 'boolean') {
    nostrStore.setDeveloperDiagnosticsEnabled(options.developerDiagnosticsEnabled);
  }

  const validation = await nostrStore.savePrivateKey(privateKey);
  if (!validation.isValid) {
    throw new Error('Invalid private key supplied for e2e bootstrap.');
  }

  let bootstrapPublishError: unknown = null;
  for (let attempt = 0; attempt <= E2E_BOOTSTRAP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await nostrStore.updateLoggedInUserRelayList(relayEntries);
      await nostrStore.publishMyRelayList(relayEntries, relayUrls);
      bootstrapPublishError = null;
      break;
    } catch (error) {
      bootstrapPublishError = error;
      if (!isRetryableBootstrapError(error) || attempt >= E2E_BOOTSTRAP_RETRY_DELAYS_MS.length) {
        throw error;
      }

      await waitForBootstrapRetry(E2E_BOOTSTRAP_RETRY_DELAYS_MS[attempt] ?? 300);
    }
  }

  if (bootstrapPublishError) {
    throw bootstrapPublishError;
  }

  await nostrStore.restoreStartupState(relayUrls);
  await Promise.all([chatStore.init(), messageStore.init()]);
  await Promise.all([chatStore.reload(), messageStore.reloadLoadedMessages()]);

  const publicKey = nostrStore.getLoggedInPublicKeyHex();
  if (!publicKey) {
    throw new Error('Failed to restore the logged-in public key.');
  }

  return createSessionSnapshot(
    publicKey,
    (candidatePublicKey) => nostrStore.encodeNpub(candidatePublicKey),
    relayUrls
  );
}

async function getSessionSnapshot(): Promise<AppE2ESessionSnapshot> {
  const [{ useNostrStore }, { useRelayStore }] = await Promise.all([
    import('src/stores/nostrStore'),
    import('src/stores/relayStore'),
  ]);

  const nostrStore = useNostrStore();
  const relayStore = useRelayStore();
  relayStore.init();
  const publicKey = nostrStore.getLoggedInPublicKeyHex();
  if (!publicKey) {
    throw new Error('Failed to read the logged-in public key.');
  }

  return createSessionSnapshot(
    publicKey,
    (candidatePublicKey) => nostrStore.encodeNpub(candidatePublicKey),
    relayStore.relays
  );
}

async function getDeveloperDiagnosticsSnapshot(): Promise<DeveloperDiagnosticsSnapshot> {
  const { useNostrStore } = await import('src/stores/nostrStore');
  const nostrStore = useNostrStore();
  return JSON.parse(
    JSON.stringify(await nostrStore.getDeveloperDiagnosticsSnapshot())
  ) as DeveloperDiagnosticsSnapshot;
}

async function isPrivateContactListMember(
  options: AppE2EContactListMemberOptions
): Promise<boolean> {
  const normalizedPublicKey = inputSanitizerService.normalizeHexKey(options.publicKey);
  if (!normalizedPublicKey) {
    return false;
  }

  const { contactsService } = await import('src/services/contactsService');
  await contactsService.init();
  const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
  return contact?.meta?.[PRIVATE_CONTACT_LIST_MEMBER_CONTACT_META_KEY] === true;
}

async function waitForAppReady(options: AppE2EWaitForAppReadyOptions = {}): Promise<void> {
  const normalizedContactPublicKey = inputSanitizerService.normalizeHexKey(
    options.contactPublicKey ?? ''
  );
  if (!normalizedContactPublicKey) {
    return;
  }

  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Math.floor(options.timeoutMs))
      : 30_000;
  const deadlineAt = Date.now() + timeoutMs;

  const [{ useNostrStore }, { contactsService }] = await Promise.all([
    import('src/stores/nostrStore'),
    import('src/services/contactsService'),
  ]);

  const nostrStore = useNostrStore();
  await contactsService.init();

  while (Date.now() <= deadlineAt) {
    if (nostrStore.isRestoringStartupState) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 100);
      });
      continue;
    }

    const contact = await contactsService.getContactByPublicKey(normalizedContactPublicKey);
    if (contact) {
      return;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 100);
    });
  }

  const targetDescription = normalizedContactPublicKey
    ? `contact ${normalizedContactPublicKey}`
    : 'startup restore';
  throw new Error(`Timed out waiting for ${targetDescription} to become ready.`);
}

async function refreshSession(options: AppE2ERefreshOptions = {}): Promise<void> {
  const [{ useNostrStore }, { useRelayStore }, { useChatStore }, { useMessageStore }] =
    await Promise.all([
      import('src/stores/nostrStore'),
      import('src/stores/relayStore'),
      import('src/stores/chatStore'),
      import('src/stores/messageStore'),
    ]);

  const nostrStore = useNostrStore();
  const relayStore = useRelayStore();
  const chatStore = useChatStore();
  const messageStore = useMessageStore();

  relayStore.init();

  await Promise.all([chatStore.init(), messageStore.init()]);
  const previousPrivateMessagesEoseAt = nostrStore.privateMessagesSubscriptionLastEoseAt ?? null;
  await nostrStore.subscribePrivateMessagesForLoggedInUser(true);
  await waitForPrivateMessagesSubscriptionEose(nostrStore, previousPrivateMessagesEoseAt);
  await chatStore.reload();

  const normalizedChatId =
    typeof options.chatId === 'string' ? options.chatId.trim().toLowerCase() : '';

  if (normalizedChatId) {
    const chat = chatStore.chats.find((entry) => entry.id === normalizedChatId) ?? null;
    if (chat?.type === 'group') {
      await nostrStore.restorePrivateMessagesForRecipient(chat.publicKey, { force: true });
      await nostrStore.waitForPrivateMessagesIngestQueue();
      const refreshedChat = await waitForGroupChatWithEpoch(chatStore, normalizedChatId, chat);
      if (refreshedChat.epochPublicKey) {
        await nostrStore.restoreGroupEpochHistory(
          refreshedChat.publicKey,
          refreshedChat.epochPublicKey,
          {
            force: true,
          }
        );
        await nostrStore.waitForPrivateMessagesIngestQueue();
      }
      await chatStore.reload();
    }

    await messageStore.loadMessages(normalizedChatId, true);
    return;
  }

  await messageStore.reloadLoadedMessages();
}

async function refreshPrivateMessagesLiveReconnect(
  options: AppE2EPrivateMessagesLiveReconnectOptions = {}
): Promise<DeveloperDiagnosticsSnapshot> {
  const { useNostrStore } = await import('src/stores/nostrStore');
  const nostrStore = useNostrStore();
  const previousPrivateMessagesEoseAt = nostrStore.privateMessagesSubscriptionLastEoseAt ?? null;

  await nostrStore.refreshPrivateMessagesLiveSubscriptionForReconnect({
    forceRecreate: options.forceRecreate !== false,
  });
  await waitForPrivateMessagesSubscriptionEose(nostrStore, previousPrivateMessagesEoseAt);
  return getDeveloperDiagnosticsSnapshot();
}

async function logout(): Promise<void> {
  const [{ useNostrStore }] = await Promise.all([import('src/stores/nostrStore')]);

  const nostrStore = useNostrStore();
  await nostrStore.logout();
  window.location.hash = '/auth';
}

async function rotateGroupEpoch(options: AppE2ERotateGroupEpochOptions): Promise<void> {
  const normalizedGroupPublicKey = options.groupPublicKey.trim();
  const normalizedMemberPublicKeys = options.memberPublicKeys
    .map((publicKey) => publicKey.trim())
    .filter((publicKey) => publicKey.length > 0);
  const relayUrls = normalizeRelayUrls(Array.isArray(options.relayUrls) ? options.relayUrls : []);

  if (!normalizedGroupPublicKey) {
    throw new Error('A group public key is required for e2e rotation.');
  }

  const [{ useNostrStore }] = await Promise.all([import('src/stores/nostrStore')]);

  const nostrStore = useNostrStore();
  await nostrStore.rotateGroupEpochAndSendTickets(
    normalizedGroupPublicKey,
    normalizedMemberPublicKeys,
    relayUrls
  );
}

async function sendMessages(
  options: AppE2ESendMessagesOptions
): Promise<AppE2ESentMessageSnapshot[]> {
  const normalizedChatId = options.chatId.trim().toLowerCase();
  const texts = options.texts
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
  const createdAts = Array.isArray(options.createdAts)
    ? options.createdAts.map((entry) => String(entry ?? '').trim())
    : [];

  if (!normalizedChatId) {
    throw new Error('A chat id is required to send e2e messages.');
  }

  if (texts.length === 0) {
    return [];
  }

  if (createdAts.length > 0 && createdAts.length !== texts.length) {
    throw new Error('Explicit e2e message timestamps must match the number of messages.');
  }

  const [{ useChatStore }, { useMessageStore }] = await Promise.all([
    import('src/stores/chatStore'),
    import('src/stores/messageStore'),
  ]);

  const chatStore = useChatStore();
  const messageStore = useMessageStore();
  const sentMessages: AppE2ESentMessageSnapshot[] = [];

  await Promise.all([chatStore.init(), messageStore.init()]);

  for (const [index, text] of texts.entries()) {
    const createdAt = createdAts[index];
    const created = await messageStore.sendMessage(
      normalizedChatId,
      text,
      null,
      createdAt
        ? {
            createdAt,
          }
        : {}
    );
    if (!created) {
      throw new Error(`Failed to send e2e message for chat ${normalizedChatId}.`);
    }

    await chatStore.updateChatPreview(normalizedChatId, created.text, created.sentAt);
    await chatStore.acceptChat(normalizedChatId, {
      lastOutgoingMessageAt: created.sentAt,
    });
    sentMessages.push({
      id: created.id,
      chatId: created.chatId,
      text: created.text,
      sentAt: created.sentAt,
      authorPublicKey: created.authorPublicKey,
      eventId: created.eventId,
    });
  }

  return JSON.parse(JSON.stringify(sentMessages)) as AppE2ESentMessageSnapshot[];
}

async function removeStoredMessageByEventId(
  options: AppE2ERemoveStoredMessageOptions
): Promise<boolean> {
  const normalizedChatId = inputSanitizerService.normalizeHexKey(options.chatId);
  const normalizedEventId = inputSanitizerService.normalizeHexKey(options.eventId);
  if (!normalizedChatId || !normalizedEventId) {
    throw new Error('A valid chat id and event id are required to remove a stored message.');
  }

  const [{ useChatStore }, { useMessageStore }, { chatDataService }, { nostrEventDataService }] =
    await Promise.all([
      import('src/stores/chatStore'),
      import('src/stores/messageStore'),
      import('src/services/chatDataService'),
      import('src/services/nostrEventDataService'),
    ]);

  const chatStore = useChatStore();
  const messageStore = useMessageStore();

  await Promise.all([
    chatStore.init(),
    messageStore.init(),
    chatDataService.init(),
    nostrEventDataService.init(),
  ]);

  const hadStoredEvent = Boolean(await nostrEventDataService.getEventById(normalizedEventId));
  const deletedMessage = await chatDataService.deleteMessageByEventId(normalizedEventId);
  await nostrEventDataService.deleteEventsByIds([normalizedEventId]);

  if (!deletedMessage && !hadStoredEvent) {
    return false;
  }

  messageStore.removeChatMessages(normalizedChatId);
  await Promise.all([messageStore.loadMessages(normalizedChatId, true), chatStore.reload()]);
  return true;
}

async function setStoredMessageAttachments(
  options: AppE2ESetStoredMessageAttachmentsOptions
): Promise<void> {
  const normalizedChatId = inputSanitizerService.normalizeHexKey(options.chatId);
  const messageText = options.messageText.trim();
  if (!normalizedChatId || !messageText) {
    throw new Error('A valid chat id and message text are required to set stored attachments.');
  }

  const [{ chatDataService }, { useMessageStore }, { normalizeMessageAttachment }] =
    await Promise.all([
      import('src/services/chatDataService'),
      import('src/stores/messageStore'),
      import('src/utils/messageAttachments'),
    ]);
  await chatDataService.init();
  const messageStore = useMessageStore();
  await messageStore.init();

  const messages = await chatDataService.listMessages(normalizedChatId);
  const message = [...messages].reverse().find((entry) => entry.message === messageText) ?? null;
  if (!message) {
    throw new Error(`Stored message was not found in chat ${normalizedChatId}.`);
  }

  const attachments = options.attachments
    .map((attachment) => normalizeMessageAttachment(attachment))
    .filter((attachment): attachment is MessageAttachmentMetadata => Boolean(attachment));
  if (attachments.length === 0) {
    throw new Error('At least one valid stored attachment is required.');
  }

  await chatDataService.updateMessageMeta(message.id, {
    ...message.meta,
    attachments,
  });
  await messageStore.loadMessages(normalizedChatId, true);
}

function startManualReconnectHealing(): void {
  void import('src/stores/nostrStore').then(({ useNostrStore }) =>
    useNostrStore().runReconnectHealing('manual-refresh')
  );
}

async function isReconnectHealing(): Promise<boolean> {
  const { useNostrStore } = await import('src/stores/nostrStore');
  return useNostrStore().isReconnectHealing;
}

async function updateContactRelays(options: AppE2EUpdateContactRelaysOptions): Promise<void> {
  const normalizedPublicKey = inputSanitizerService.normalizeHexKey(options.publicKey);
  if (!normalizedPublicKey) {
    throw new Error('A valid public key is required to update contact relays.');
  }

  const relayEntries = inputSanitizerService.normalizeRelayEntriesFromUrls(
    Array.isArray(options.relayUrls) ? options.relayUrls : []
  );

  const { contactsService } = await import('src/services/contactsService');
  await contactsService.init();

  const contact = await contactsService.getContactByPublicKey(normalizedPublicKey);
  if (!contact) {
    throw new Error(`Contact ${normalizedPublicKey} was not found.`);
  }

  const updatedContact = await contactsService.updateContact(contact.id, {
    relays: relayEntries,
  });
  if (!updatedContact) {
    throw new Error(`Failed to update relays for contact ${normalizedPublicKey}.`);
  }
}

async function replaceStoredGroupMembers(
  options: AppE2EReplaceStoredGroupMembersOptions
): Promise<void> {
  const normalizedGroupPublicKey = inputSanitizerService.normalizeHexKey(options.groupPublicKey);
  if (!normalizedGroupPublicKey) {
    throw new Error('A valid group public key is required to update stored group members.');
  }

  const normalizedMemberPublicKeys = Array.from(
    new Set(
      (Array.isArray(options.memberPublicKeys) ? options.memberPublicKeys : [])
        .map((value) => inputSanitizerService.normalizeHexKey(value))
        .filter((value): value is string => Boolean(value))
    )
  );

  const { contactsService } = await import('src/services/contactsService');
  await contactsService.init();

  const contact = await contactsService.getContactByPublicKey(normalizedGroupPublicKey);
  if (!contact || contact.type !== 'group') {
    throw new Error(`Group contact ${normalizedGroupPublicKey} was not found.`);
  }

  const nextMeta = {
    ...(contact.meta ?? {}),
  };
  if (normalizedMemberPublicKeys.length > 0) {
    nextMeta.group_members = normalizedMemberPublicKeys.map((publicKey) => ({
      public_key: publicKey,
      name: publicKey,
    }));
  } else {
    delete nextMeta.group_members;
  }

  const updatedContact = await contactsService.updateContact(contact.id, {
    meta: nextMeta,
  });
  if (!updatedContact) {
    throw new Error(`Failed to update stored group members for ${normalizedGroupPublicKey}.`);
  }
}

export function installAppE2EBridge(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const bridge: AppE2EBridge = {
    bootstrapSession,
    getDeveloperDiagnosticsSnapshot,
    getSessionSnapshot,
    isPrivateContactListMember,
    refreshSession,
    refreshPrivateMessagesLiveReconnect,
    logout,
    removeStoredMessageByEventId,
    setStoredMessageAttachments,
    startManualReconnectHealing,
    isReconnectHealing,
    rotateGroupEpoch,
    replaceStoredGroupMembers,
    sendMessages,
    updateContactRelays,
    waitForAppReady,
  };

  Object.defineProperty(window, WINDOW_BRIDGE_KEY, {
    configurable: true,
    value: bridge,
  });
}
