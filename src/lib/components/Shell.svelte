<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import GroupSeedBackup from './GroupSeedBackup.svelte';
  import GroupRestore from './GroupRestore.svelte';
  let groupFlow: 'choose' | 'details' | 'backup' | 'restore' = 'choose';
  import { onMount, tick } from 'svelte';
  import { autosizeTextarea } from '#src/lib/actions/autosizeTextarea.ts';
  import { threadHistoryPull } from '#src/lib/actions/threadHistoryPull.ts';
  import { locale, translate } from '#src/i18n.ts';
  import { goto } from '$app/navigation';
  import { page as routeState } from '$app/state';
  import { toStore } from 'svelte/store';
  const page = toStore(() => ({ url: routeState.url }));
  import { countUnseenReactionsForAuthor } from '#src/utils/messageReactions.ts';
  import { useChatStore } from '#src/stores/chatStore.ts';
  import { useMessageStore, isMissingContactRelaysError } from '#src/stores/messageStore.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useRelayStore } from '#src/stores/relayStore.ts';
  import { useCallStore } from '#src/stores/callStore.ts';
  import { useCallRoomStore } from '#src/stores/callRoomStore.ts';
  import { contactsService } from '#src/services/contactsService.ts';
  import {
    prepareEncryptedMedia,
    uploadPreparedEncryptedMedia,
    validateEncryptedMediaFile,
  } from '#src/services/blossomUploadService.ts';
  import {
    createPrivateMediaUploadSession,
    type PrivateMediaUploadOutcome,
  } from '#src/services/privateMediaUploadSession.ts';
  import { sendMediaThenPersistServer } from '#src/utils/sendMediaThenPersistServer.ts';
  import {
    isPrivateMediaNoticeDismissed,
    setPrivateMediaNoticeDismissed,
  } from '#src/utils/privateMediaNoticePreference.ts';
  import { normalizeBlossomServerUrl } from '#src/utils/blossomServer.ts';
  import {
    buildImageAttachmentPreviewText,
    redactFileMessageSecretTags,
  } from '#src/utils/messageAttachments.ts';
  import { getPublicProfile, type PublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { observe } from '#src/lib/state/store.ts';
  import {
    readTopLevelBunkerLoginQueryParam,
    removeTopLevelBunkerLoginQueryParam,
    ALREADY_LOGGED_IN_BUNKER_MESSAGE,
  } from '#src/utils/bunkerLoginQuery.ts';
  import { Notify } from '#src/lib/platform/ui.ts';
  import { parseRoomLink } from '#src/utils/callRoom.ts';
  import type { Chat, Message, MessageReplyPreview } from '#src/types/chat.ts';
  import type { ContactRecord } from '#src/types/contact.ts';
  import ProfileName from './ProfileName.svelte';
  import Avatar from './Avatar.svelte';
  import ChatRow from './ChatRow.svelte';
  import ProfileSearchResults from './ProfileSearchResults.svelte';
  import type { ProfileSearchResult } from '#src/stores/nostr/profileSearchRuntime.ts';
  import ChatRequests from './ChatRequests.svelte';
  import ContactDetails from './ContactDetails.svelte';
  import ContactsList from './ContactsList.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import {
    buildGroupMemberMentionProfiles,
    serializeMentionDraft,
  } from '#src/utils/nostrMentions.ts';
  import Icon from './Icon.svelte';
  import StartupHistory from './StartupHistory.svelte';
  import CallOverlay from './CallOverlay.svelte';
  import { ROOM_MAX_MEMBERS } from '#src/types/callRoom.ts';
  import MessageReactions from './MessageReactions.svelte';
  import MessageBody from './MessageBody.svelte';
  import MessageRelayStatus from './MessageRelayStatus.svelte';
  import MessageActions from './MessageActions.svelte';
  import {
    readDesktopSidebarWidthPreference,
    saveDesktopSidebarWidthPreference,
    MIN_DESKTOP_SIDEBAR_WIDTH,
    MAX_DESKTOP_SIDEBAR_WIDTH,
    readDesktopMessageLayoutPreference,
    readDarkModePreference,
    DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT,
  } from '#src/utils/themeStorage.ts';
  let sidebarWidth = readDesktopSidebarWidthPreference();
  let resizing = false;
  let highlightedMessage = '',
    searchIndex = -1;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let messageLayout = readDesktopMessageLayoutPreference();
  const chats = useChatStore(),
    messages = useMessageStore(),
    nostr = useNostrStore(),
    relays = useRelayStore();
  relays.init();
  const state = observe(() => ({
    chats: chats.visibleChats,
    requests: chats.requestChats,
    selected: chats.selectedChat,
    chatIds: new Set(chats.chats.map((chat) => chat.id)),
    profiles: new Map(
      [
        nostr.getLoggedInPublicKeyHex() ?? '',
        chats.selectedChat?.publicKey ?? '',
        ...(chats.selectedChatId
          ? messages.getMessages(chats.selectedChatId).map((message) => message.authorPublicKey)
          : []),
      ].map((key) => [key, getPublicProfile(key)]),
    ),
    thread: {
      items: chats.selectedChatId ? messages.getMessages(chats.selectedChatId) : [],
      pagination: chats.selectedChatId ? messages.getPaginationState(chats.selectedChatId) : null,
    },
    unread: chats.unreadChatCount,
    loaded: chats.isLoaded,
    relayEntries: relays.relayEntries,
    relayVersion: nostr.relayStatusVersion,
    contactVersion: nostr.contactListVersion,
  }));
  let section: 'chats' | 'contacts' | 'settings' = 'chats';
  let mobileThread = false;
  let mobileViewport = matchMedia('(max-width: 767px)').matches;
  let query = '';
  let profileSearch: ProfileSearchResults | undefined;
  async function openAuthor(publicKey: string) {
    await act(async () => {
      const chat =
        chats.chats.find((chat) => chat.publicKey === publicKey) ??
        (await chats.addContact(getPublicProfile(publicKey)?.name || publicKey, publicKey));
      if (chat) await open(chat);
    });
  }
  async function openSearchProfile(profile: ProfileSearchResult) {
    await act(async () => {
      const chat =
        chats.chats.find((chat) => chat.publicKey === profile.publicKey) ??
        (await chats.addContact(profile.name, profile.publicKey, { picture: profile.picture }));
      if (chat) {
        query = '';
        await open(chat);
      }
      void nostr
        .refreshContactByPublicKey(profile.publicKey, profile.name, {
          refreshRelayList: true,
          relayListSeedRelayUrls: profile.relayUrls,
        })
        .catch(() => {});
    });
  }
  let draft = '';
  let reply: MessageReplyPreview | null = null;
  let editing: Message | null = null;
  let beforeEdit: { draft: string; reply: MessageReplyPreview | null } | null = null;
  function finishEditing() {
    if (beforeEdit) {
      draft = beforeEdit.draft;
      reply = beforeEdit.reply;
      chats.setComposerDraft(currentId, draft);
    }
    editing = null;
    beforeEdit = null;
  }
  let busy = false;
  let modal: '' | 'contact' | 'group' | 'profile' | 'forward' | 'room' | 'info' | 'upload' = '';
  let identifier = '';
  let contactName = '';
  let groupMembers = '';
  let groupAbout = '';
  let modalError = '';
  let contacts: ContactRecord[] = [];
  // Profile hydration may cache a contact before its request is accepted.
  // Use the inbox classification so acceptance/replies update this list live.
  $: requestContactKeys = new Set($state.requests.flatMap((chat) => [chat.id, chat.publicKey]));
  $: visibleContacts = contacts.filter(
    (contact) =>
      !requestContactKeys.has(contact.public_key) &&
      !requestContactKeys.has(contact.meta.chatId ?? ''),
  );
  let contactSelectedKey = '';
  let contactsQuery = '';
  let contactsRefreshBusy = false;
  let contactLoadRevision = 0;
  let showRequests = false;
  let menu = false;
  let emoji = false;
  let threadSearch = '';
  let searching = false;
  let searchResults: { messageId: string; text: string }[] = [];
  let forward: Message | null = null;
  let scrollArea: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let composerInput: HTMLTextAreaElement;
  let attachmentMenu = false;
  let pendingFile: File | null = null;
  // Private media is always encrypted locally and sent as NIP-17 kind 15. A failed upload keeps
  // the prepared ciphertext, key and nonce in the session so Retry never encrypts again, and there
  // is no plaintext path to fall back to.
  let mediaPhase: 'notice' | 'uploading' | 'sending' | 'failed' = 'notice';
  let mediaError = '';
  let mediaCanRetry = false;
  let mediaServer = '';
  let mediaServerDraft = '';
  let changingMediaServer = false;
  let dismissMediaNotice = false;
  let mediaChatId = '';
  let mediaReply: MessageReplyPreview | null = null;
  let mediaRun = 0;
  let mediaAbort: AbortController | null = null;
  const privateMediaUpload = createPrivateMediaUploadSession<File>({
    prepare: prepareEncryptedMedia,
    upload: (prepared, serverUrl) =>
      uploadPreparedEncryptedMedia(prepared, {
        serverUrl,
        signUploadAuthHeader: nostr.signBlossomUploadAuthHeader,
        ...(mediaAbort ? { signal: mediaAbort.signal } : {}),
      }),
    getPersistedServerUrl: () => nostr.getPrivateMediaBlossomServerUrl(),
  });
  $: normalizedMediaServerDraft = normalizeBlossomServerUrl(mediaServerDraft);
  // Closing the upload dialog by any route cancels the encrypted upload and drops its key.
  $: if (modal !== 'upload' && pendingFile) cancelMediaUpload();
  let inspectedMessage: Message | null = null;
  let contextMessage = '';
  let contextPosition = { x: 0, y: 0 };
  let contextTrigger: HTMLElement | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressOrigin = { x: 0, y: 0 };
  let suppressPressClickUntil = 0;
  $: actionMessage = $state.thread.items.find(
    (message) => message.id === contextMessage && !message.meta.deleted,
  );
  function showMessageActions(message: Message, event: MouseEvent) {
    if (message.meta.deleted) return;
    event.preventDefault();
    cancelMessagePress();
    contextTrigger =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.message-menu-trigger')
        : null;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    contextPosition =
      event.clientX || event.clientY
        ? { x: event.clientX, y: event.clientY }
        : { x: bounds.left, y: bounds.bottom };
    contextMessage = message.id;
  }
  function closeMessageActions() {
    contextMessage = '';
    contextTrigger?.focus({ preventScroll: true });
    contextTrigger = null;
  }
  function cancelMessagePress() {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  }
  function startMessagePress(message: Message, event: PointerEvent) {
    if (
      event.pointerType === 'mouse' ||
      !event.isPrimary ||
      message.meta.deleted ||
      (event.target as HTMLElement).closest('button, a, input, textarea')
    )
      return;
    cancelMessagePress();
    pressOrigin = { x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => {
      contextTrigger = null;
      suppressPressClickUntil = Date.now() + 750;
      contextPosition = pressOrigin;
      contextMessage = message.id;
      pressTimer = undefined;
    }, 500);
  }
  async function messageAction(action: string, message: Message) {
    contextMessage = '';
    if (action === 'reply') {
      setReply(message);
      await tick();
      composerInput?.focus();
    } else if (action === 'copy') await act(() => navigator.clipboard.writeText(message.text));
    else if (action === 'forward') {
      forward = message;
      modal = 'forward';
    } else if (action === 'info') {
      inspectedMessage = message;
      modal = 'info';
    } else if (action === 'edit') {
      if (!editing) beforeEdit = { draft, reply };
      editing = message;
      draft = message.text;
      await tick();
      composerInput?.focus();
    } else if (action === 'delete')
      await act(() => messages.deleteMessage(message.chatId, message.id));
  }
  let autocompleteIndex = 0,
    dismissedAutocomplete = '',
    composerCursor = 0;
  let emojiEntries: typeof import('#src/data/topEmojis.ts').TOP_EMOJIS = [];
  let emojiLoad: Promise<void> | undefined;
  $: beforeCursor = draft.slice(0, composerCursor);
  $: emojiQuery = /(?:^|\s):([\w+-]*)$/.exec(beforeCursor)?.[1];
  $: if (emojiQuery !== undefined && !emojiLoad)
    emojiLoad = import('#src/data/topEmojis.ts').then((module) => {
      emojiEntries = module.TOP_EMOJIS;
    });
  $: emojiSuggestions =
    emojiQuery !== undefined && dismissedAutocomplete !== beforeCursor
      ? emojiEntries
          .filter((e) => e.label.includes(emojiQuery!.toLowerCase().replaceAll('_', ' ')))
          .slice(0, 8)
      : [];

  const callState = observe(() => ({
    phase: useCallStore().session?.phase,
    room: useCallRoomStore().session,
  }));
  $: nostr.setVisibleProfileTargets(
    section === 'contacts'
      ? [nostr.getLoggedInPublicKeyHex() ?? '', contactSelectedKey]
      : [...$state.profiles.keys()],
    section === 'contacts'
      ? contacts.find((contact) => contact.public_key === contactSelectedKey)?.type === 'group'
        ? contactSelectedKey
        : ''
      : $state.selected?.type === 'group'
        ? $state.selected.publicKey
        : '',
  );
  $: selectedName =
    $state.selected?.meta.given_name ||
    $state.profiles.get($state.selected?.publicKey ?? '')?.name ||
    $state.selected?.meta.contact_name ||
    $state.selected?.name ||
    '';
  $: mentionProfiles = buildGroupMemberMentionProfiles($state.selected?.meta);
  $: mentionQuery = /(?:^|\s)@([\w-]*)$/.exec(beforeCursor)?.[1];
  $: mentionSuggestions =
    mentionQuery !== undefined && dismissedAutocomplete !== beforeCursor
      ? mentionProfiles
          .filter(
            (p) =>
              p.displayName.toLowerCase().includes(mentionQuery!.toLowerCase()) ||
              p.handle.toLowerCase().startsWith(mentionQuery!.toLowerCase()),
          )
          .slice(0, 8)
      : [];
  $: canCall =
    $state.selected?.type === 'user' &&
    $state.selected.publicKey !== nostr.getLoggedInPublicKeyHex() &&
    $state.selected.meta.inbox_state !== 'blocked';
  $: callBusy = Boolean(($callState.phase && $callState.phase !== 'ended') || $callState.room);

  $: unreadBoundary = $state.selected?.unreadCount
    ? String($state.selected.meta.last_seen_received_activity_at ?? '')
    : '';
  let selectedRelayUrls: string[] = [];
  let relayContactLoad = 0;
  $: relayContactSource = `${$state.selected?.publicKey ?? ''}:${$state.contactVersion}`;
  $: void loadSelectedRelayUrls(relayContactSource);
  async function loadSelectedRelayUrls(source: string) {
    const revision = ++relayContactLoad;
    const key = source.split(':')[0];
    selectedRelayUrls = [];
    if (!key) return;
    try {
      const contact = await contactsService.getContactByPublicKey(key);
      if (revision === relayContactLoad)
        selectedRelayUrls = contact?.relays.map((relay) => relay.url) ?? [];
    } catch { /* Recorded delivery statuses remain available without contact metadata. */ }
  }
  const markingReactions = new Set<string>();
  $: unseenReactionMessages = $state.thread.items.filter(
    (message) =>
      message.sender === 'me' &&
      countUnseenReactionsForAuthor(message.meta.reactions ?? [], nostr.getLoggedInPublicKeyHex()) >
        0,
  );
  $: firstUnreadId = $state.selected?.unreadCount
    ? $state.thread.items.find(
        (message) => message.sender !== 'me' && (!unreadBoundary || message.sentAt > unreadBoundary),
      )?.id
    : undefined;
  $: if (unseenReactionMessages.length) void tick().then(markVisibleReactions);
  async function markVisibleReactions() {
    if (!scrollArea || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const bounds = scrollArea.getBoundingClientRect();
    const chatId = $state.selected?.id;
    if (!chatId) return;
    const ids = unseenReactionMessages
      .filter((message) => {
        if (markingReactions.has(message.id)) return false;
        const rect = document.getElementById(`message-${message.id}`)?.getBoundingClientRect();
        return rect && rect.top < bounds.bottom && rect.bottom > bounds.top + 38;
      })
      .map((message) => message.id);
    if (!ids.length) return;
    ids.forEach((id) => markingReactions.add(id));
    try {
      await messages.markMessagesReactionsViewed(chatId, ids);
    } catch {
      Notify.create({ type: 'negative', message: 'Unable to save reaction read status.' });
    } finally {
      ids.forEach((id) => markingReactions.delete(id));
    }
  }
  let currentId = '';
  let scrollTop = 0,
    stickyDay = '',
    scrollFrame = 0;
  let pullStart: number | null = null;
  let nearBottom = true;
  $: if ($page.url.pathname.startsWith('/settings')) section = 'settings';
  else if ($page.url.pathname.startsWith('/contacts')) section = 'contacts';
  else section = 'chats';
  $: chats.setSearchQuery(query);
  $: contactSelectedKey =
    section === 'contacts' && /^[a-f0-9]{64}$/.test($page.url.pathname.split('/')[2] ?? '')
      ? $page.url.pathname.split('/')[2]
      : '';
  $: if (section === 'contacts' && $state.contactVersion >= 0) void loadContacts();
  $: showRequests = $page.url.pathname === '/chats/requests';
  $: routedChatId = section === 'chats' ? $page.url.pathname.split('/')[2] : undefined;
  $: if (routedChatId && $state.chatIds.has(routedChatId) && $state.selected?.id !== routedChatId)
    chats.selectChat(routedChatId);
  $: mobileThread =
    section === 'contacts'
      ? Boolean(contactSelectedKey)
      : section === 'chats' && /^\/chats\/[^/]+/.test($page.url.pathname);
  $: if ($state.selected?.id && $state.selected.id !== currentId) {
    currentId = $state.selected.id;
    draft = chats.getComposerDraft(currentId);
    reply = null;
    editing = null;
    beforeEdit = null;
    void loadThread(currentId);
  }
  $: visibleChatId =
    section === 'chats' && !showRequests && (!mobileViewport || mobileThread)
      ? ($state.selected?.id ?? null)
      : null;
  $: nostr.setAppLifecycleRouteChatId(visibleChatId);
  $: nostr.prioritizeThreadHistory(visibleChatId);
  $: if ($state.thread.items.length && nearBottom)
    void tick().then(() => {
      scrollToBottom(scrollArea);
    });
  function mountThread(node: HTMLDivElement) {
    const previousTop = scrollTop;
    void tick().then(() => {
      if (nearBottom) scrollToBottom(node);
      else node.scrollTop = previousTop;
    });
    const id = chats.selectedChatId;
    if (id)
      void chats
        .markAsRead(id)
        .then((cursor) => {
          if (cursor) nostr.scheduleContactCursorPublish(id, cursor);
        })
        .catch(fail);
  }
  function scrollToBottom(node: HTMLDivElement | undefined) {
    if (node) {
      node.scrollTop = node.scrollHeight;
      updateStickyDay();
    }
  }
  function updateStickyDay() {
    if (!scrollArea) return;
    const top = scrollArea.getBoundingClientRect().top + 38;
    const rows = scrollArea.querySelectorAll<HTMLElement>('.message-row');
    void markVisibleReactions();
    stickyDay =
      Array.from(rows).find((row) => row.getBoundingClientRect().bottom > top)?.dataset.dayLabel ??
      rows[rows.length - 1]?.dataset.dayLabel ??
      '';
  }
  function fail(error: unknown) {
    Notify.create({
      type: 'negative',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  async function act(fn: () => unknown) {
    try {
      await fn();
    } catch (e) {
      if (
        isMissingContactRelaysError(e) &&
        confirm('No relays found for this contact. Use your application relays?')
      ) {
        try {
          await contactsService.updateSendMessagesToAppRelays(e.chatPublicKey, true);
          await fn();
        } catch (cause) {
          fail(cause);
        }
      } else fail(e);
    }
  }
  async function loadThread(id: string) {
    stickyDay = '';
    nearBottom = true;
    await messages.loadMessages(id);
    await tick();
    scrollToBottom(scrollArea);
  }
  async function open(chat: Chat) {
    if (chat.meta.deleted_locally === true) {
      const reopened = await chats.addContact(chat.name, chat.publicKey);
      if (!reopened) return;
      chat = reopened;
    }
    nostr.prioritizeThreadHistory(chat.publicKey, true);
    showRequests = false;
    await goto(`/chats/${chat.id}`);
    chats.selectChat(chat.id);
    nostr.setAppLifecycleRouteChatId(chat.id);
    mobileThread = true;
    await loadThread(chat.id);
    await chats.markAsRead(chat.id);
  }
  async function loadContacts() {
    const revision = ++contactLoadRevision;
    try {
      const next = await contactsService.listContacts();
      if (revision === contactLoadRevision) contacts = next;
    } catch (error) {
      fail(error);
    }
  }
  function selectContact(contact: ContactRecord) {
    void goto(`/contacts/${contact.public_key}`, { replaceState: !mobileViewport });
  }
  async function openContactChat(contact: ContactRecord) {
    if (contact.meta.blocked) return;
    await nostr.ensureRespondedPubkeyIsContact(contact.public_key, contact.given_name ?? '');
    await nostr.publishPrivateContactList();
    const chat = await chats.addContact(contact.name || contact.public_key, contact.public_key);
    if (chat) await open(chat);
  }
  async function contactAction(contact: ContactRecord, action: string) {
    await act(async () => {
      if (action === 'chat') await openContactChat(contact);
      else if (action === 'refresh')
        await nostr.refreshContactByPublicKey(contact.public_key, contact.name, {
          refreshRelayList: true,
        });
      else if (action === 'mute') await nostr.mutePubkey(contact.public_key, relays.relays);
      else if (action === 'unmute') await nostr.unmutePubkey(contact.public_key, relays.relays);
      else if (action === 'block' || action === 'unblock')
        await nostr[action === 'block' ? 'blockPubkey' : 'unblockPubkey'](
          contact.public_key,
          relays.relays,
          { fallbackName: contact.name, type: contact.type },
        );
      else if (action === 'delete') {
        if (!(await contactsService.deleteContact(contact.id))) return;
        if (contactSelectedKey === contact.public_key)
          await goto('/contacts', { replaceState: true });
        await loadContacts();
        await nostr.publishPrivateContactList(relays.relays);
      }
      await loadContacts();
    });
  }
  async function refreshContacts() {
    if (contactsRefreshBusy) return;
    contactsRefreshBusy = true;
    try {
      await act(async () => {
        for (const contact of contacts.filter((contact) => !contact.meta.blocked))
          await nostr
            .refreshContactByPublicKey(contact.public_key, contact.name, { refreshRelayList: true })
            .catch(fail);
        await loadContacts();
      });
    } finally {
      contactsRefreshBusy = false;
    }
  }
  async function nav(next: typeof section) {
    mobileThread = false;
    await goto(`/${next}`);
    if (next === 'contacts') await loadContacts();
  }
  async function send() {
    const chat = $state.selected;
    if (!chat || !draft.trim() || busy) return;
    busy = true;
    const text = serializeMentionDraft(draft, mentionProfiles);
    const editedMessage = editing;
    const originalReply = reply;
    draft = '';
    if (!editedMessage) chats.clearComposerDraft(chat.id);
    nearBottom = true;
    try {
      if (editedMessage) await messages.editMessage(chat.id, editedMessage.id, text);
      else await messages.sendMessage(chat.id, text, originalReply);
      if (currentId === chat.id) {
        if (editedMessage) finishEditing();
        else reply = null;
      }
    } catch (e) {
      if (
        isMissingContactRelaysError(e) &&
        confirm('No relays found for this contact. Use your application relays?')
      ) {
        try {
          await contactsService.updateSendMessagesToAppRelays(chat.publicKey, true);
          await messages.sendMessage(chat.id, text, reply, {
            relayUrls: relays.relays,
            continueFromMessageId: e.localMessageId ?? undefined,
          });
        } catch (cause) {
          fail(cause);
        }
      } else {
        if (currentId === chat.id) draft = text;
        fail(e);
      }
    } finally {
      busy = false;
    }
  }
  let olderLoad: { chatId: string } | null = null;
  $: loadingOlder = Boolean(
    (olderLoad !== null && olderLoad.chatId === $state.selected?.id) ||
    $state.thread.pagination?.isLoadingOlder,
  );
  function canLoadOlder() {
    return Boolean(
      $state.selected &&
      $state.thread.pagination?.hasOlder &&
      !loadingOlder &&
      olderLoad?.chatId !== $state.selected.id,
    );
  }
  async function older() {
    if (!canLoadOlder() || !scrollArea) return;
    const chatId = $state.selected!.id;
    const node = scrollArea;
    const operation = { chatId };
    olderLoad = operation;
    nearBottom = false;
    cancelMessagePress();
    contextMessage = '';
    node.focus({ preventScroll: true });
    const top = node.getBoundingClientRect().top;
    const anchor = [...node.querySelectorAll<HTMLElement>('.message-row')].find(
      (row) => row.getBoundingClientRect().bottom > top + 38,
    );
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : null;
    const previousTop = node.scrollTop,
      previousHeight = node.scrollHeight;
    const current = () =>
      chats.selectedChatId === chatId && scrollArea === node && node.isConnected;
    try {
      await messages.loadOlderMessages(chatId);
      const firstId = messages.getMessages(chatId)[0]?.id;
      // The Vue-to-Svelte bridge batches notifications. tick() alone can run
      // before the new window reaches the DOM, especially while hydrating.
      for (let frame = 0; current() && $state.thread.items[0]?.id !== firstId && frame < 4; frame++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await tick();
      if (!current()) return;
      if (anchor?.isConnected && anchorOffset !== null)
        node.scrollTop +=
          anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - anchorOffset;
      else node.scrollTop = previousTop + Math.max(0, node.scrollHeight - previousHeight);
      scrollTop = node.scrollTop;
      updateStickyDay();
    } finally {
      if (olderLoad === operation) olderLoad = null;
    }
  }
  function messageAuthor(
    message: Message,
    chat: Chat | null,
    profiles: typeof mentionProfiles,
    publicProfiles: Map<string, PublicProfile | undefined>,
    ownName: string,
  ) {
    const profile = publicProfiles.get(message.authorPublicKey);
    if (message.sender === 'me') return { name: ownName, picture: profile?.picture ?? '' };
    const member = profiles.find((profile) => profile.publicKey === message.authorPublicKey);
    // Resolve labels from the authenticated author, never from a previous selection.
    const directPeer = chat?.type === 'user' && chat.publicKey === message.authorPublicKey;
    return {
      name:
        profile?.name ||
        member?.displayName ||
        (directPeer ? chat.name : message.authorPublicKey.slice(0, 12)),
      picture:
        profile?.picture ?? member?.picture ?? (directPeer ? String(chat.meta.picture ?? '') : ''),
    };
  }
  function setReply(message: Message) {
    reply = {
      messageId: message.id,
      // An encrypted attachment's text is its ciphertext URL; reply with its preview label instead.
      text: (message.meta.attachments ?? []).some((attachment) => attachment.encryption)
        ? buildImageAttachmentPreviewText(message.text, message.meta)
        : message.text,
      sender: message.sender,
      authorName: messageAuthor(
        message,
        $state.selected,
        mentionProfiles,
        $state.profiles,
        $translate('common.you'),
      ).name,
      authorPublicKey: message.authorPublicKey,
      sentAt: message.sentAt,
      eventId: message.eventId,
    };
  }
  async function searchThread() {
    if (!$state.selected) return;
    const q = threadSearch,
      chatId = $state.selected.id;
    const results = q.trim() ? await messages.searchMessages(chatId, q) : [];
    if (q === threadSearch && chatId === $state.selected?.id) {
      searchResults = results.map((r) => ({ messageId: String(r.messageId), text: r.text }));
      searchIndex = results.length ? 0 : -1;
      if (results.length) await jump(String(results[0].messageId));
    }
  }
  function queueSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void searchThread(), 120);
  }
  async function moveSearch(offset: number) {
    if (!searchResults.length) return;
    searchIndex = (searchIndex + offset + searchResults.length) % searchResults.length;
    await jump(searchResults[searchIndex]!.messageId);
  }
  async function jump(id: string) {
    const chatId = $state.selected?.id;
    if (!chatId) return;
    nearBottom = false;
    const target = await messages.ensureMessageLoaded(chatId, id);
    if (!target || $state.selected?.id !== chatId) return;
    await tick();
    highlightedMessage = target.id;
    document.getElementById(`message-${target.id}`)?.scrollIntoView({ block: 'center' });
  }
  async function openReplyTarget(message: Message) {
    const preview = message.meta.reply;
    const chatId = message.chatId;
    if (!preview) return;
    nearBottom = false;
    let target = preview.eventId
      ? await messages.ensureMessageLoadedByEventId(chatId, preview.eventId)
      : await messages.ensureMessageLoaded(chatId, preview.messageId);
    const eventId =
      preview.eventId || (/^[a-f0-9]{64}$/.test(preview.messageId) ? preview.messageId : '');
    if (!target && eventId) {
      await nostr.repairMissingMessageDependency(chatId, eventId, {
        reason: 'reply-open',
        immediate: true,
        force: true,
        referenceCreatedAt: Math.floor(Date.parse(preview.sentAt || message.sentAt) / 1000),
      });
      target = await messages.ensureMessageLoadedByEventId(chatId, eventId);
    }
    if (target && $state.selected?.id === chatId) await jump(target.id);
  }
  function resizeTo(width: number) {
    sidebarWidth = Math.round(
      Math.max(
        MIN_DESKTOP_SIDEBAR_WIDTH,
        Math.min(MAX_DESKTOP_SIDEBAR_WIDTH, window.innerWidth * 0.75, width),
      ),
    );
    saveDesktopSidebarWidthPreference(sidebarWidth);
  }
  function resizeKey(event: KeyboardEvent) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      resizeTo(
        event.key === 'Home'
          ? MIN_DESKTOP_SIDEBAR_WIDTH
          : event.key === 'End'
            ? MAX_DESKTOP_SIDEBAR_WIDTH
            : sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16),
      );
    }
  }
  async function chatAction(chat: Chat, action: string) {
    await act(async () => {
      if (action === 'profile') {
        await open(chat);
        openProfile();
      } else if (action === 'refresh' || action === 'refresh-group') {
        await nostr.refreshContactByPublicKey(chat.publicKey, chat.name);
        if (action === 'refresh-group') await nostr.refreshPrivateMessages();
        await chats.reload();
      } else if (action === 'mute')
        await (chat.meta.muted
          ? nostr.unmutePubkey(chat.id, relays.relays)
          : nostr.mutePubkey(chat.id, relays.relays));
      else if (action === 'accept') await chats.acceptChat(chat.id);
      else if (action === 'read') {
        const cursor = await chats.markAsRead(chat.id);
        if (cursor) nostr.scheduleContactCursorPublish(chat.id, cursor);
      } else if (action === 'block' && confirm('Block this conversation?'))
        await chats.blockChat(chat.id);
      else if (action === 'delete' && confirm('Delete this conversation?'))
        await chats.deleteChat(chat.id);
    });
  }
  async function addContact() {
    busy = true;
    modalError = '';
    try {
      const found = await nostr.resolveIdentifier(identifier);
      if (!found.isValid || !found.normalizedPubkey)
        throw new Error('Enter a valid npub, public key, or NIP-05 address.');
      const addingInContacts = section === 'contacts';
      const chat = addingInContacts
        ? null
        : await chats.addContact(
            contactName || found.resolvedName || found.normalizedPubkey,
            found.normalizedPubkey,
          );
      await nostr.ensureRespondedPubkeyIsContact(found.normalizedPubkey, contactName);
      await nostr.publishPrivateContactList();
      modal = '';
      if (addingInContacts) {
        await loadContacts();
        await goto(`/contacts/${found.normalizedPubkey}`);
      } else if (chat) await open(chat);
    } catch (e) {
      modalError = String(e);
    } finally {
      busy = false;
    }
  }
  function openProfile() {
    groupMembers = ($state.selected?.meta.group_members ?? [])
      .map((member) => nostr.encodeNpub(member.public_key))
      .join('\n');
    contactName = $state.selected?.name ?? '';
    modal = 'profile';
  }
  async function createGroup(recoveryPhrase: string) {
    busy = true;
    modalError = '';
    try {
      const keys: string[] = [];
      for (const member of groupMembers.split(/[\s,]+/).filter(Boolean)) {
        const found = await nostr.resolveIdentifier(member);
        if (!found.normalizedPubkey) throw new Error(`Invalid member: ${member}`);
        keys.push(found.normalizedPubkey);
      }
      const result = await nostr.createGroupChat({
        recoveryPhrase,
        name: contactName,
        about: groupAbout,
        relayUrls: relays.relays,
      });
      const warnings: string[] = [];
      try {
        await nostr.publishGroupMetadata(
          result.groupPublicKey,
          { name: contactName, about: groupAbout, group: true },
          result.relayUrls,
        );
      } catch {
        warnings.push(
          'Group created locally; publish its profile again when relays are available.',
        );
      }
      if (!result.groupSecretSave.publishedRelayUrls.length)
        warnings.push('Group backup has not reached a relay yet.');
      if (result.memberListSyncError || result.contactListSyncError)
        warnings.push('Some group settings need to be synced again.');
      if (keys.length) {
        try {
          const invitations = await nostr.publishGroupMemberChanges(
            result.groupPublicKey,
            keys,
            result.relayUrls,
          );
          if (invitations.failedMemberPubkeys.length)
            warnings.push(
              `${invitations.failedMemberPubkeys.length} invitations need a retry from the group Members tab.`,
            );
        } catch {
          warnings.push('Group created; retry adding members from the group Members tab.');
        }
      }
      if (warnings.length) Notify.create({ type: 'warning', message: warnings.join(' ') });
      await chats.reload();
      modal = '';
      const chat = chats.chats.find((c) => c.publicKey === result.groupPublicKey);
      if (chat) await open(chat);
    } catch (e) {
      modalError = String(e);
    } finally {
      busy = false;
    }
  }
  function chooseUpload(accept: string) {
    attachmentMenu = false;
    fileInput.accept = accept;
    fileInput.click();
  }
  function prepareUpload(file?: File) {
    // An upload that is waiting, running or offering Retry is never replaced by another file.
    if (!file || !$state.selected || busy || pendingFile) return;
    const validationError = validateEncryptedMediaFile(file);
    if (validationError) {
      Notify.create({ type: 'warning', message: validationError });
      if (fileInput) fileInput.value = '';
      return;
    }
    privateMediaUpload.reset();
    pendingFile = file;
    mediaChatId = $state.selected.id;
    mediaReply = reply;
    mediaPhase = 'notice';
    mediaError = '';
    mediaCanRetry = false;
    changingMediaServer = false;
    dismissMediaNotice = false;
    mediaServer = nostr.getPrivateMediaBlossomServerUrl();
    modal = 'upload';
    // The notice is informational only: skipping it goes through the same encrypted upload with
    // the same validation, errors, Retry, Change server and Cancel.
    if (isPrivateMediaNoticeDismissed()) void commitUpload();
  }
  function upload(event: Event) {
    prepareUpload((event.target as HTMLInputElement).files?.[0]);
  }
  function commitUpload() {
    const file = pendingFile;
    if (!file || mediaPhase !== 'notice') return;
    if (dismissMediaNotice) setPrivateMediaNoticeDismissed(true);
    void runMediaUpload(() => {
      mediaServer = privateMediaUpload.refreshActiveServerUrl();
      return privateMediaUpload.start(file);
    });
  }
  function retryMediaUpload() {
    if (!mediaCanRetry || mediaPhase !== 'failed') return;
    void runMediaUpload(() => privateMediaUpload.retry());
  }
  // Retries the same ciphertext, key and nonce on the entered server. The saved server only
  // changes after the kind 15 message has actually been sent.
  function retryMediaUploadOnServer() {
    const serverUrl = normalizedMediaServerDraft;
    if (!serverUrl || !mediaCanRetry || mediaPhase !== 'failed') return;
    mediaServer = serverUrl;
    changingMediaServer = false;
    void runMediaUpload(() => privateMediaUpload.retryWithServer(serverUrl));
  }
  async function runMediaUpload(start: () => Promise<PrivateMediaUploadOutcome>) {
    const run = ++mediaRun;
    const chatId = mediaChatId,
      replyTo = mediaReply;
    busy = true;
    mediaPhase = 'uploading';
    mediaError = '';
    mediaAbort = new AbortController();
    let outcome: PrivateMediaUploadOutcome;
    try {
      // The signer is checked before every attempt, including retries.
      await nostr.ensureBlossomUploadAuthentication();
      if (run !== mediaRun) return;
      outcome = await start();
    } catch (error) {
      if (run !== mediaRun) return;
      mediaPhase = 'failed';
      mediaCanRetry = privateMediaUpload.hasPreparedUpload();
      mediaError =
        error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
      busy = false;
      return;
    } finally {
      if (run === mediaRun) mediaAbort = null;
    }
    // Cancelled while the upload was finishing: nothing is sent.
    if (run !== mediaRun) return;
    mediaPhase = 'sending';
    try {
      await sendMediaThenPersistServer({
        send: () => messages.sendMediaAttachment(chatId, outcome.result.attachment, replyTo),
        serverToPersist: outcome.serverToPersist,
        persistServer: (serverUrl) => nostr.savePrivateMediaBlossomServerUrl(serverUrl),
        onPersistError: () =>
          Notify.create({
            type: 'warning',
            message: $translate('message.mediaUpload.serverNotSaved'),
          }),
      });
      if (reply === replyTo) reply = null;
    } catch (error) {
      fail(error);
    } finally {
      if (run === mediaRun) {
        busy = false;
        pendingFile = null;
        if (modal === 'upload') modal = '';
      }
      if (fileInput) fileInput.value = '';
    }
  }
  function cancelMediaUpload() {
    const wasRunning = mediaPhase === 'uploading' || mediaPhase === 'sending';
    mediaRun += 1;
    mediaAbort?.abort();
    mediaAbort = null;
    privateMediaUpload.reset();
    pendingFile = null;
    mediaPhase = 'notice';
    mediaError = '';
    mediaCanRetry = false;
    changingMediaServer = false;
    if (wasRunning) busy = false;
    if (fileInput) fileInput.value = '';
    if (modal === 'upload') modal = '';
  }
  function insertEmoji(value: string) {
    const start = composerInput?.selectionStart ?? draft.length,
      end = composerInput?.selectionEnd ?? start;
    draft = draft.slice(0, start) + value + draft.slice(end);
    if (!editing) chats.setComposerDraft(currentId, draft);
    emoji = false;
    void tick().then(() => {
      composerInput?.focus();
      composerInput?.setSelectionRange(start + value.length, start + value.length);
    });
  }
  function updateComposerCursor() {
    composerCursor = composerInput?.selectionStart ?? draft.length;
    autocompleteIndex = 0;
  }
  function replaceAutocomplete(value: string, kind: '@' | ':') {
    const start = beforeCursor.lastIndexOf(kind);
    draft = draft.slice(0, start) + value + ' ' + draft.slice(composerCursor);
    composerCursor = start + value.length + 1;
    if (!editing) chats.setComposerDraft(currentId, draft);
    void tick().then(() => {
      composerInput?.focus();
      composerInput?.setSelectionRange(composerCursor, composerCursor);
    });
  }
  function insertMention(handle: string) {
    replaceAutocomplete('@' + handle, '@');
  }
  function composerKey(event: KeyboardEvent) {
    const count = mentionSuggestions.length || emojiSuggestions.length;
    if (
      count &&
      ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key) &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (event.key === 'Escape') dismissedAutocomplete = beforeCursor;
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
        autocompleteIndex =
          (autocompleteIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      else if (mentionSuggestions.length)
        insertMention(
          mentionSuggestions[autocompleteIndex]?.handle ?? mentionSuggestions[0].handle,
        );
      else
        replaceAutocomplete(
          emojiSuggestions[autocompleteIndex]?.emoji ?? emojiSuggestions[0].emoji,
          ':',
        );
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }
  function openRequests() {
    menu = false;
    mobileThread = true;
    chats.setVisibleChatId(null);
    void goto('/chats/requests');
  }
  function time(value: string) {
    return value
      ? new Date(value).toLocaleTimeString($locale, { hour: '2-digit', minute: '2-digit' })
      : '';
  }
  function date(value: string) {
    const date = new Date(value);
    return date.toLocaleDateString($locale, {
      day: '2-digit',
      month: 'long',
      ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    });
  }
  onMount(() => {
    if (readTopLevelBunkerLoginQueryParam()) {
      removeTopLevelBunkerLoginQueryParam();
      Notify.create({ message: ALREADY_LOGGED_IN_BUNKER_MESSAGE });
    }
    const invite = $page.url.hash.startsWith('#/call/')
      ? $page.url.hash.slice(1)
      : $page.url.pathname.startsWith('/call/')
        ? $page.url.pathname
        : '';
    if (invite) {
      identifier = invite;
      modal = 'room';
    }
    const savedDark = readDarkModePreference();
    document.body.classList.toggle(
      'body--dark',
      savedDark ?? localStorage.getItem('anagram-theme') !== 'light',
    );
    const updateLayout = () => {
      messageLayout = readDesktopMessageLayoutPreference();
    };
    window.addEventListener(DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT, updateLayout);
    void chats.init().then(() => {
      const id = $page.url.pathname.split('/')[2];
      if (id && chats.chats.some((c) => c.id === id)) {
        chats.selectChat(id);
        nostr.setAppLifecycleRouteChatId(section === 'chats' && !showRequests ? id : null);
        mobileThread = true;
        void chats.markAsRead(id).then((cursor) => {
          if (cursor) nostr.scheduleContactCursorPublish(id, cursor);
        });
      }
    });
    nostr.startAppLifecycleRuntime();
    void nostr.initializeSessionState().catch(fail);
    return () => {
      window.removeEventListener(DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT, updateLayout);
      clearTimeout(searchTimer);
      cancelMessagePress();
      cancelAnimationFrame(scrollFrame);
      nostr.stopAppLifecycleRuntime();
      chats.setVisibleChatId(null);
      nostr.prioritizeThreadHistory(null);
    };
  });
</script>

<svelte:window
  onresize={() => (mobileViewport = matchMedia('(max-width: 767px)').matches)}
  onfocus={() => void markVisibleReactions()}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      closeMessageActions();
      emoji = false;
      attachmentMenu = false;
      menu = false;
    }
  }}
  onclick={(e) => {
    if (
      menu &&
      !e
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches('.chat-options-menu, .chat-options-trigger'),
        )
    )
      menu = false;
    if (
      Date.now() < suppressPressClickUntil &&
      e.target instanceof Element &&
      e.target.closest('.message-row')
    ) {
      e.preventDefault();
      return;
    }
    if (
      !e
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches('.message-context-menu, .message-menu-trigger'),
        )
    )
      contextMessage = '';
  }}
  onpointermove={(e) => {
    if (resizing) resizeTo(e.clientX);
  }}
  onpointerup={() => (resizing = false)}
  onblur={() => (resizing = false)}
/>
<svelte:head
  ><title>{$state.unread ? `(${$state.unread}) ` : ''}{$translate('Anagram')}</title></svelte:head
>
{#if section === 'settings'}
  {#await import('./settings/SettingsShell.svelte') then component}<component.default
      bind:width={sidebarWidth}
    />{/await}
{:else}
  <div
    class="app-shell"
    style:--desktop-sidebar-width={`${sidebarWidth}px`}
    class:show-thread={mobileThread}
    class:group-thread={$state.selected?.type === 'group'}
    class:bubble-layout={messageLayout === 'bubbles'}
  >
    <aside class="sidebar">
      {#if section === 'chats'}
        <div class="sidebar-top">
          <div class="sidebar-top-row">
            <input
              class="sidebar-search"
              aria-label="Search chats"
              placeholder={$translate('common.search')}
              bind:value={query}
              onkeydown={(event) => profileSearch?.handleKeydown(event)}
              autocomplete="off"
              data-testid="chat-search-input"
            />
            {#if query}<button
                class="icon-button small"
                aria-label="Clear search"
                onclick={() => (query = '')}><Icon name="close" /></button
              >{/if}
            <button
              class="icon-button"
              aria-label="Refresh messages"
              data-testid="refresh-chats-button"
              onclick={() => act(() => nostr.refreshPrivateMessages())}
              ><Icon name="refresh" /></button
            >
            <button
              class="icon-button chat-options-trigger"
              aria-label="Chat options"
              data-testid="start-new-chat-button"
              aria-expanded={menu}
              onclick={() => (menu = !menu)}><Icon name="group" /></button
            >
          </div>
        </div>
      {:else}<header class="sidebar-header">
          <h1>{$translate(section === 'contacts' ? 'Contacts' : 'Settings')}</h1>
          {#if section === 'contacts'}<button
              class="icon-button"
              aria-label={$translate('contacts.refreshContacts')}
              data-testid="refresh-contacts-button"
              disabled={contactsRefreshBusy}
              onclick={refreshContacts}><Icon name="refresh" /></button
            ><button
              class="icon-button"
              aria-label={$translate('contacts.addContact')}
              onclick={() => {
                modal = 'contact';
                identifier = '';
                contactName = '';
              }}><Icon name="add" /></button
            >{/if}
        </header>{/if}
      {#if menu}<div class="dropdown chat-options-menu">
          <button
            data-testid="new-chat-button"
            onclick={() => {
              modal = 'contact';
              identifier = '';
              contactName = '';
              modalError = '';
              menu = false;
            }}>{$translate('chat.newChat')}</button
          >
          <button
            onclick={() => {
              openRequests();
            }}>Message requests ({$state.requests.length})</button
          ><button
            onclick={() => {
              modal = 'group'; groupFlow = 'choose';
              contactName = '';
              groupMembers = '';
              groupAbout = '';
              modalError = '';
              menu = false;
            }}>New private group</button
          ><button
            onclick={() => {
              modal = 'room';
              identifier = '';
              menu = false;
            }}>Create or join a call</button
          >
        </div>{/if}
      {#if section === 'contacts'}<div class="search-box">
          <input
            aria-label={$translate('contacts.filterContacts')}
            placeholder={$translate('contacts.filterContacts')}
            bind:value={contactsQuery}
            data-testid="contact-list-search"
          />
        </div>{/if}
      <div
        class="sidebar-content"
        role="region"
        aria-label="Conversations and navigation"
        ontouchstart={(e) => {
          pullStart = e.currentTarget.scrollTop === 0 ? (e.touches[0]?.clientY ?? null) : null;
        }}
        ontouchend={(e) => {
          if (
            pullStart !== null &&
            window.innerWidth < 768 &&
            (e.changedTouches[0]?.clientY ?? 0) - pullStart > 80
          )
            if (section === 'contacts') void refreshContacts();
            else void act(() => nostr.refreshPrivateMessages());
          pullStart = null;
        }}
        ontouchcancel={() => (pullStart = null)}
      >
        {#if section === 'chats'}
          {#if $state.requests.length}<button
              class="requests-row"
              data-testid="requests-row"
              onclick={openRequests}
              ><span class="requests-icon"><Icon name="chat" /></span><span
                ><strong>{$translate('chat.requests')} ({$state.requests.length})</strong><small
                  >{$translate('message.unknownInboundChatsStay')}</small
                ></span
              ></button
            >{/if}
          {#each $state.chats as chat (chat.id)}
            <ChatRow
              {chat}
              ownPublicKey={nostr.getLoggedInPublicKeyHex() ?? ''}
              active={$state.selected?.id === chat.id}
              onselect={open}
              onaction={chatAction}
            />
          {/each}
          <ProfileSearchResults
            bind:this={profileSearch}
            {query}
            existingKeys={$state.chats.map((chat) => chat.publicKey)}
            onselect={openSearchProfile}
          />
        {:else if section === 'contacts'}
          <ContactsList
            contacts={visibleContacts}
            query={contactsQuery}
            selectedKey={contactSelectedKey}
            onselect={selectContact}
            onaction={contactAction}
          />
        {/if}
      </div>
      <StartupHistory />
      <nav class="nav-rail" aria-label="Main navigation">
        {#each ['chats', 'contacts', 'settings'] as item}<button
            class="nav-rail__btn"
            class:nav-rail__btn--active={section === item}
            aria-label={item}
            onclick={() => nav(item as typeof section)}
            ><Icon name={item} />{#if item === 'chats' && $state.unread}<span
                class="badge nav-badge">{$state.unread}</span
              >{/if}</button
          >{/each}
      </nav>
    </aside>
    <!-- WAI-ARIA window splitter is a focusable separator with a value. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
    <div
      class="sidebar-resizer"
      role="separator"
      aria-label="Resize left panel"
      aria-orientation="vertical"
      aria-valuemin={MIN_DESKTOP_SIDEBAR_WIDTH}
      aria-valuemax={Math.min(
        MAX_DESKTOP_SIDEBAR_WIDTH,
        typeof window !== 'undefined' ? window.innerWidth * 0.75 : MAX_DESKTOP_SIDEBAR_WIDTH,
      )}
      aria-valuenow={sidebarWidth}
      tabindex="0"
      onpointerdown={(e) => {
        e.preventDefault();
        resizing = true;
      }}
      onkeydown={resizeKey}
    ></div>
    <main class="main-panel">
      {#if section === 'contacts'}
        <div class="contact-panel" data-testid="contact-panel">
          {#if contactSelectedKey}{#key contactSelectedKey}<ContactDetails
                publicKey={contactSelectedKey}
                onopen={openContactChat}
                onback={() => goto('/contacts')}
              />{/key}
          {:else}<div class="contact-empty">
              {$translate('contacts.selectContactViewProfile')}
            </div>{/if}
        </div>
      {:else if showRequests && section === 'chats'}<ChatRequests
          requests={$state.requests}
          onopen={open}
          onaction={chatAction}
          onback={() => {
            mobileThread = false;
            goto('/chats');
          }}
        />
      {:else if $state.selected && section === 'chats'}
        <header class="thread-header">
          <button
            class="icon-button mobile-back"
            aria-label="Back to chats"
            onclick={() => {
              mobileThread = false;
              chats.setVisibleChatId(null);
              goto('/chats');
            }}><Icon name="back" /></button
          ><Avatar
            privateGroup={$state.selected.type === 'group'}
            name={selectedName}
            publicKey={$state.selected.publicKey}
            eager
            picture={String($state.selected.meta.picture ?? '')}
          /><button class="thread-identity" onclick={openProfile}
            ><strong>{selectedName}</strong><small
              >{$state.selected.type === 'group'
                ? 'Private group'
                : 'Last active ' +
                  new Date($state.selected.lastMessageAt || Date.now()).toLocaleString($locale, {
                    hour: 'numeric',
                    minute: '2-digit',
                    month: 'short',
                    day: 'numeric',
                  })}</small
            ></button
          >
          <div class="header-actions">
            {#if $state.selected.type === 'group'}<button
                class="icon-button"
                aria-label="Create or join a call"
                data-testid="thread-group-call"
                onclick={() => {
                  modal = 'room';
                  identifier = '';
                }}><Icon name="group" /></button
              >{/if}
            {#if canCall}<button
                class="icon-button"
                aria-label="Audio call"
                data-testid="thread-audio-call"
                disabled={callBusy}
                onclick={() => act(() => useCallStore().start($state.selected!.publicKey, 'audio'))}
                ><Icon name="phone" /></button
              ><button
                class="icon-button"
                aria-label="Video call"
                data-testid="thread-video-call"
                disabled={callBusy}
                onclick={() => act(() => useCallStore().start($state.selected!.publicKey, 'video'))}
                ><Icon name="video" /></button
              >{/if}
            <button
              class="icon-button"
              aria-label="Search conversation"
              onclick={() => (searching = !searching)}><Icon name="search" /></button
            ><button class="icon-button" aria-label="Contact profile" onclick={openProfile}
              ><Icon name="contacts" /></button
            >
          </div>
        </header>
        {#if searching}<div class="thread-search">
            <input
              aria-label="Search messages"
              bind:value={threadSearch}
              oninput={queueSearch}
              onkeydown={(e) => {
                if (e.key === 'Enter') void moveSearch(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') searching = false;
              }}
              placeholder="Search in this conversation"
            /><span data-testid="thread-search-status"
              >{searchResults.length
                ? `${searchIndex + 1} / ${searchResults.length}`
                : threadSearch
                  ? 'No results'
                  : ''}</span
            >
            <button
              class="icon-button"
              aria-label="Previous search result"
              disabled={!searchResults.length}
              onclick={() => moveSearch(1)}>↑</button
            ><button
              class="icon-button"
              aria-label="Next search result"
              disabled={!searchResults.length}
              onclick={() => moveSearch(-1)}>↓</button
            ><button
              class="icon-button"
              aria-label="Close search"
              onclick={() => {
                searching = false;
                highlightedMessage = '';
              }}><Icon name="close" /></button
            >
            <div class="search-results">
              {#each searchResults.slice(0, 30) as result}<button
                  onclick={() => jump(result.messageId)}>{result.text}</button
                >{/each}
            </div>
          </div>{/if}
        <div
          class="messages"
          bind:this={scrollArea}
          use:mountThread
          use:threadHistoryPull={{
            chatId: $state.selected?.id ?? '',
            canLoad: canLoadOlder,
            loading: () => loadingOlder,
            load: () => void act(older),
          }}
          class:loading-history={loadingOlder}
          tabindex="-1"
          onscroll={() => {
            contextMessage = '';
            cancelMessagePress();
            if (!loadingOlder)
              nearBottom =
                scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 100;
            scrollTop = scrollArea.scrollTop;
            if (!scrollFrame)
              scrollFrame = requestAnimationFrame(() => {
                scrollFrame = 0;
                updateStickyDay();
              });
          }}
          role="log"
          aria-label="Messages"
          data-testid="chat-thread"
          data-chat-public-key={$state.selected?.publicKey}
        >
          {#if $state.thread.items.length}<div class="thread-day-sticky" aria-hidden="true">
              <span>{stickyDay || date($state.thread.items[0].sentAt)}</span>
            </div>{/if}
          {#if $state.thread.pagination?.hasOlder}<div class="thread-more thread-more--top">
              <button
                class="thread-more__button"
                data-testid="thread-load-older"
                aria-label="Load earlier messages"
                aria-busy={loadingOlder}
                disabled={loadingOlder}
                onmousedown={(event) => event.preventDefault()}
                onclick={() => act(older)}><Icon name="up" />{$translate('common.more')}</button
              >
            </div>{/if}
          {#each $state.thread.items as message, index (message.id)}
            {@const author = messageAuthor(message, $state.selected, mentionProfiles, $state.profiles, $translate('common.you'))}
            {@const continuesSender = index > 0 && message.authorPublicKey === $state.thread.items[index - 1].authorPublicKey && date(message.sentAt) === date($state.thread.items[index - 1].sentAt)}
            {@const senderContinues = index + 1 < $state.thread.items.length && message.authorPublicKey === $state.thread.items[index + 1].authorPublicKey && date(message.sentAt) === date($state.thread.items[index + 1].sentAt)}
            {#if index === 0 || date(message.sentAt) !== date($state.thread.items[index - 1].sentAt)}<div
                class="date-divider"
              >
                <span>{date(message.sentAt)}</span>
              </div>{/if}
            {#if message.id === firstUnreadId}<div
                class="unread-divider"
                data-testid="thread-unread-separator"
              >
                {$translate('relays.unreadMessages')}
              </div>{/if}
            <article
              class="message-row"
              data-day-label={date(message.sentAt)}
              class:context-open={contextMessage === message.id}
              oncontextmenu={(event) => showMessageActions(message, event)}
              onpointerdown={(event) => startMessagePress(message, event)}
              onpointermove={(event) => {
                if (Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > 8)
                  cancelMessagePress();
              }}
              onpointerup={cancelMessagePress}
              onpointercancel={cancelMessagePress}
              class:highlighted={highlightedMessage === message.id}
              class:sender-continuation={continuesSender}
              class:sender-continues={senderContinues}
              class:own={message.sender === 'me'}
              id="message-{message.id}"
              data-testid="message-bubble"
              data-chat-public-key={message.chatId}
              data-author-public-key={message.authorPublicKey}
              style="content-visibility:auto;contain-intrinsic-size:auto 80px"
            >
              {#if messageLayout === 'bubbles'}
                {#if !senderContinues}<button class="bubble-avatar"
                  data-testid="thread-author-profile-link" aria-label={`Open profile: ${author.name}`}
                  onclick={() => openAuthor(message.authorPublicKey)}>
                  <Avatar publicKey={message.authorPublicKey} eager picture={author.picture} name={author.name} size={38} />
                </button>{/if}
              {:else}
                <button class="message-author" data-testid="thread-author-profile-link"
                  onclick={() => openAuthor(message.authorPublicKey)}>
                  <Avatar publicKey={message.authorPublicKey} eager picture={author.picture} name={author.name} size={36} />
                  <strong>{author.name}</strong>
                </button>
              {/if}
              <div class="message-content">
                {#if messageLayout === 'bubbles' && !continuesSender}
                  <button class="bubble-author-name" data-testid="thread-author-name-link"
                    style:color={`var(--bubble-author-${(Number.parseInt(message.authorPublicKey.slice(0, 8), 16) || 0) % 6})`}
                    onclick={() => openAuthor(message.authorPublicKey)}>{author.name}</button>
                {/if}
                {#if message.meta.reply}<button
                    class="reply-preview"
                    onclick={() => act(() => openReplyTarget(message))}
                    >{message.meta.reply.authorName}: {message.meta.reply.text}</button
                  >{/if}
                <MessageBody
                  {message}
                  bubbleLayout={messageLayout === 'bubbles'}
                  {mentionProfiles}
                  canRedial={canCall && !callBusy}
                  onredial={(mode) =>
                    act(() => useCallStore().start($state.selected!.publicKey, mode))}
                  oncontact={(pubkey) => void openAuthor(pubkey)}
                  onroom={(link) => {
                    identifier = link;
                    modal = 'room';
                  }}
                />
                <div class:bubble-footer={messageLayout === 'bubbles' && Boolean(message.meta.reactions?.length)}
                  class:bubble-time-only={messageLayout === 'bubbles' && !message.meta.reactions?.length}>
                <span class="message-time"
                  >{#if message.meta.edited}<span data-testid="message-edited-label"
                      >edited ·
                    </span>{/if}{time(message.sentAt)}<MessageRelayStatus
                      {message}
                      contactName={$state.selected?.name ?? ''}
                      contactRelayUrls={selectedRelayUrls}
                    /></span
                >
                {#if message.meta.reactions?.length}<MessageReactions {message} />{/if}
                </div>
              </div>
              {#if !message.meta.deleted}<button
                  class="icon-button message-menu-trigger"
                  aria-label="Message actions"
                  aria-expanded={contextMessage === message.id}
                  aria-haspopup="menu"
                  aria-controls={contextMessage === message.id ? 'message-context-menu' : undefined}
                  onclick={(event) =>
                    contextMessage === message.id
                      ? closeMessageActions()
                      : showMessageActions(message, event)}><Icon name="more" /></button
                >
              {/if}
            </article>
          {:else}<div class="empty-thread">
              <Icon name="lock" />
              <p>This is the beginning of your private conversation.</p>
            </div>{/each}
          {#if $state.thread.pagination?.hasNewer}<button
              class="load-older"
              onclick={() => act(() => messages.loadNewerMessages($state.selected!.id))}
              >Load newer messages</button
            >{/if}
        </div>
        {#if unseenReactionMessages.length}<button
            class="jump-reactions"
            aria-label="Jump to first new reaction"
            onclick={() => jump(unseenReactionMessages[0].id)}
            >♥ {unseenReactionMessages.reduce(
              (total, message) =>
                total +
                countUnseenReactionsForAuthor(
                  message.meta.reactions ?? [],
                  nostr.getLoggedInPublicKeyHex(),
                ),
              0,
            )}</button
          >{/if}
        {#if !nearBottom}<button
            class="jump-latest"
            aria-label="Jump to latest messages"
            onclick={() =>
              act(async () => {
                if ($state.selected) await messages.loadMessages($state.selected.id);
                nearBottom = true;
                await tick();
                scrollToBottom(scrollArea);
              })}><Icon name="down" /></button
          >{/if}
        {#if chats.isRequestChat($state.selected.id)}<div class="request-banner">
            Message request <button
              class="primary"
              onclick={() => act(() => chats.acceptChat($state.selected!.id))}
              >{$translate('Accept')}</button
            ><button class="danger" onclick={() => act(() => chats.blockChat($state.selected!.id))}
              >{$translate('Block')}</button
            >
          </div>{/if}
        {#if reply || editing}<div class="composer-context">
            {editing ? 'Editing message' : `Reply to ${reply?.authorName}: ${reply?.text}`}<button
              aria-label="Cancel reply or edit"
              onclick={() => {
                if (editing) finishEditing();
                else reply = null;
              }}><Icon name="close" /></button
            >
          </div>{/if}
        {#if emoji}<div class="composer-picker"><EmojiPicker onselect={insertEmoji} /></div>{/if}
        {#if mentionSuggestions.length}<div
            class="mention-suggestions"
            role="listbox"
            aria-label="Mention suggestions"
          >
            {#each mentionSuggestions as profile, index}<button
                type="button"
                role="option"
                aria-selected={autocompleteIndex === index}
                data-testid="message-mention-option"
                onclick={() => insertMention(profile.handle)}
                >{profile.displayName} <small>@{profile.handle}</small></button
              >{/each}
          </div>{/if}
        {#if emojiSuggestions.length && !mentionSuggestions.length}<div
            class="mention-suggestions"
            role="listbox"
            aria-label="Emoji suggestions"
          >
            {#each emojiSuggestions as entry, index}<button
                type="button"
                role="option"
                aria-selected={autocompleteIndex === index}
                onclick={() => replaceAutocomplete(entry.emoji, ':')}
                >{entry.emoji} <small>{entry.label}</small></button
              >{/each}
          </div>{/if}
        {#if attachmentMenu}<div class="attachment-menu">
            <button onclick={() => chooseUpload('image/*,video/*,audio/*')}
              >{$translate('message.photoOrVideo')}</button
            ><button onclick={() => chooseUpload('*/*')}>{$translate('message.file')}</button>
          </div>{/if}
        <form
          class="composer"
          onsubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div class="composer-input">
            <button
              type="button"
              class="icon-button"
              aria-label="Attach media"
              data-testid="message-composer-menu"
              disabled={busy || Boolean(editing)}
              onclick={() => (attachmentMenu = !attachmentMenu)}><Icon name="attach" /></button
            ><textarea
              bind:value={draft}
              bind:this={composerInput}
              use:autosizeTextarea={draft}
              onpaste={(e) => {
                const file = e.clipboardData?.files[0];
                if (file) {
                  e.preventDefault();
                  prepareUpload(file);
                }
              }}
              ondragover={(e) => e.preventDefault()}
              ondrop={(e) => {
                e.preventDefault();
                prepareUpload(e.dataTransfer?.files[0]);
              }}
              aria-label="Message"
              placeholder="Write a message"
              rows="1"
              data-testid="message-composer-input"
              oninput={(e) => {
                draft = e.currentTarget.value;
                dismissedAutocomplete = '';
                updateComposerCursor();
                if (!editing) chats.setComposerDraft(currentId, draft);
              }}
              onclick={updateComposerCursor}
              onkeyup={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                  updateComposerCursor();
              }}
              onkeydown={composerKey}></textarea><button
              type="button"
              class="icon-button"
              aria-label="Emoji"
              data-testid="message-composer-emoji"
              onclick={() => (emoji = !emoji)}><Icon name="smile" /></button
            ><input
              hidden
              type="file"
              accept="image/*,video/*,audio/*"
              bind:this={fileInput}
              onchange={upload}
            />
          </div>
          <button
            class="send-button"
            aria-label="Send message"
            data-testid="message-send-button"
            disabled={busy || !draft.trim()}><Icon name="send" /></button
          >
        </form>
      {:else}<div class="welcome-empty">
          <div class="welcome-mark">...</div>
          <p>{$translate('chat.selectChatStartMessaging')}</p>
        </div>{/if}
    </main>
  </div>
  {#if modal}
    <div class="modal-backdrop" role="presentation" use:dismissOnBackdrop={() => (modal = '')}>
      <div class="modal" role="dialog" tabindex="-1" aria-modal="true" aria-label={modal}>
        <header>
          <h2>
            {modal === 'info'
              ? $translate('common.nostrInfo')
              : modal === 'upload'
                ? $translate('message.photoOrVideo')
                : modal === 'contact'
                  ? 'New conversation'
                  : modal === 'group'
                    ? groupFlow === 'choose'
                      ? 'Private group'
                      : groupFlow === 'restore'
                        ? 'Restore private group'
                        : 'Create private group'
                    : modal === 'forward'
                      ? 'Forward message'
                      : modal === 'room'
                        ? 'Group call'
                        : $state.selected?.name}
          </h2>
          <button class="icon-button" aria-label="Close dialog" onclick={() => (modal = '')}
            ><Icon name="close" /></button
          >
        </header>
        {#if modal === 'info' && inspectedMessage}<dl class="message-info">
            <dt>{$translate('common.sent')}</dt>
            <dd>{new Date(inspectedMessage.sentAt).toLocaleString()}</dd>
            <dt>{$translate('contacts.authorPubkey')}</dt>
            <dd>{inspectedMessage.authorPublicKey}</dd>
            <dt>{$translate('message.eventId')}</dt>
            <dd>{inspectedMessage.eventId || 'Not published yet'}</dd>
          </dl>
          <button
            class="outline"
            onclick={() =>
              act(() => navigator.clipboard.writeText(inspectedMessage?.eventId ?? ''))}
            >Copy event ID</button
          >{#each inspectedMessage.nostrEvent?.relay_statuses ?? [] as status}<p>
              {status.relay_url} — {status.status}
              {#if inspectedMessage.sender === 'me' && status.status === 'failed' && (status.scope === 'recipient' || status.scope === 'self')}<button
                  class="outline"
                  onclick={() =>
                    act(async () => {
                      await nostr.retryDirectMessageRelay(
                        Number(inspectedMessage!.id),
                        status.relay_url,
                        status.scope as 'recipient' | 'self',
                      );
                      if (inspectedMessage)
                        inspectedMessage =
                          messages
                            .getMessages(inspectedMessage.chatId)
                            .find((message) => message.id === inspectedMessage?.id) ??
                          inspectedMessage;
                    })}>Retry</button
                >{/if}
            </p>{/each}{#if inspectedMessage.nostrEvent?.event}<details>
              <summary>Event JSON</summary>
              <pre class="event-json">{JSON.stringify(
                  {
                    ...inspectedMessage.nostrEvent.event,
                    // Kind 15 decryption material is not shown in the copyable event view.
                    tags: redactFileMessageSecretTags(inspectedMessage.nostrEvent.event.tags ?? []),
                  },
                  null,
                  2,
                )}</pre>
            </details>{/if}
        {:else if modal === 'upload'}{#if mediaPhase === 'notice'}<p>
              {$translate('message.mediaEncryptionNotice')}
            </p>
            <p>
              {$translate('message.mediaUpload.usingPrivateMediaServer', { server: mediaServer })}
            </p>
            <p>{pendingFile?.name}</p>
            <label class="media-notice-dismiss"
              ><input
                type="checkbox"
                data-testid="composer-media-notice-dont-show"
                bind:checked={dismissMediaNotice}
              />{$translate('message.mediaNoticeDontShowAgain')}</label
            >
            <button class="outline" onclick={cancelMediaUpload}
              >{$translate('common.cancel')}</button
            ><button class="primary" data-testid="composer-media-upload-confirm" onclick={commitUpload}
              >{$translate('common.ok')}</button
            >
          {:else if mediaPhase === 'failed'}<p class="error" role="alert">{mediaError}</p>
            <p>{pendingFile?.name}</p>
            {#if changingMediaServer}<label
                >{$translate('mediaDataStorage.serverUrl')}<input
                  type="url"
                  inputmode="url"
                  autocapitalize="none"
                  spellcheck="false"
                  data-testid="composer-media-upload-server-input"
                  bind:value={mediaServerDraft}
                /></label
              ><small>{$translate('message.mediaUpload.changeServerHint')}</small>
              {#if mediaServerDraft.trim() && !normalizedMediaServerDraft}<p class="error">
                  {$translate('mediaDataStorage.serverUrlInvalid')}
                </p>{/if}
            {/if}
            <div>
              <button
                class="outline"
                data-testid="composer-media-upload-cancel"
                onclick={cancelMediaUpload}>{$translate('common.cancel')}</button
              >{#if mediaCanRetry && !changingMediaServer}<button
                  class="outline"
                  data-testid="composer-media-upload-change-server"
                  onclick={() => {
                    mediaServerDraft = mediaServer;
                    changingMediaServer = true;
                  }}>{$translate('message.mediaUpload.changeServer')}</button
                ><button
                  class="primary"
                  data-testid="composer-media-upload-retry"
                  onclick={retryMediaUpload}>{$translate('message.mediaUpload.retry')}</button
                >{:else if mediaCanRetry}<button
                  class="primary"
                  data-testid="composer-media-upload-use-server"
                  disabled={!normalizedMediaServerDraft}
                  onclick={retryMediaUploadOnServer}
                  >{$translate('message.mediaUpload.useServerAndRetry')}</button
                >{/if}
            </div>
          {:else}<p role="status" data-testid="composer-media-upload-status">
              {mediaPhase === 'sending'
                ? $translate('message.mediaUpload.sending')
                : $translate('message.mediaUpload.uploadingToServer', { server: mediaServer })}
            </p>
            <p>{pendingFile?.name}</p>
            {#if mediaPhase === 'uploading'}<button
                class="outline"
                data-testid="composer-media-upload-cancel"
                onclick={cancelMediaUpload}>{$translate('common.cancel')}</button
              >{/if}
          {/if}
        {:else if modal === 'contact'}<label
            >Public key or NIP-05 address<input
              bind:value={identifier}
              placeholder="npub… or name@example.com"
              data-testid="contact-identifier-input"
            /></label
          ><label>{$translate('Name (optional)')}<input bind:value={contactName} /></label><button
            class="primary"
            disabled={busy || !identifier}
            onclick={addContact}>Add contact</button
          ><button
            class="link"
            onclick={() => {
              modal = 'group'; groupFlow = 'choose';
              contactName = '';
              groupMembers = '';
              groupAbout = '';
            }}>Create a private group</button
          >
        {:else if modal === 'group'}
          {#if groupFlow === 'choose'}
            <div class="group-choices">
              <button class="primary" onclick={() => (groupFlow = 'details')}>Generate new group</button>
              <button class="outline" onclick={() => (groupFlow = 'restore')}>Restore group</button>
            </div>
          {:else if groupFlow === 'restore'}
            <GroupRestore onback={() => (groupFlow = 'choose')} onrestored={async (key) => { await chats.reload(); modal = ''; await goto(`/chats/${key}`); }} />
          {:else if groupFlow === 'backup'}
            <GroupSeedBackup relayUrls={relays.relays} {busy} onverified={createGroup} />
          {:else}<label>Group name<input bind:value={contactName} /></label
          ><label>Description<textarea bind:value={groupAbout}></textarea></label><label
            >{$translate('Members')}<textarea
              bind:value={groupMembers}
              placeholder="Public keys or NIP-05 addresses, separated by commas"></textarea></label
          >
          <p>Members receive an encrypted invitation.</p>
          <button class="outline" disabled={busy} onclick={() => (groupFlow = 'choose')}>Back</button>
          <button class="primary" disabled={busy || !contactName} onclick={() => (groupFlow = 'backup')}
            >Continue</button
          >
          {/if}
        {:else if modal === 'forward'}{#each $state.chats as chat}<button
              class="settings-item"
              onclick={() =>
                act(async () => {
                  if (forward) await messages.forwardMessage(chat.id, forward);
                  modal = '';
                })}
              ><Avatar privateGroup={chat.type === 'group'} name={chat.name} publicKey={chat.publicKey} size={36} />{chat.name}</button
            >{/each}
        {:else if modal === 'room'}
          <p>{$translate('room.description', { count: ROOM_MAX_MEMBERS })}</p>
          <label
            >{$translate('room.pasteLink')}<textarea
              bind:value={identifier}
              data-testid="room-join-link"
              placeholder={$translate('room.pasteLink')}></textarea></label
          >
          {#if identifier.trim() && !parseRoomLink(identifier.trim())}<p role="alert" class="error">
              {$translate('room.error.invalidLink')}
            </p>{/if}
          {#if identifier.trim()}
            <button
              class="primary"
              data-testid="room-join-audio"
              disabled={!parseRoomLink(identifier.trim()) || useCallRoomStore().busy}
              onclick={() =>
                act(async () => {
                  const link = parseRoomLink(identifier.trim());
                  if (link) {
                    await useCallRoomStore().join(link, 'audio');
                    modal = '';
                  }
                })}>{$translate('room.joinAudio')}</button
            >
            <button
              class="primary"
              data-testid="room-join-video"
              disabled={!parseRoomLink(identifier.trim()) || useCallRoomStore().busy}
              onclick={() =>
                act(async () => {
                  const link = parseRoomLink(identifier.trim());
                  if (link) {
                    await useCallRoomStore().join(link, 'video');
                    modal = '';
                  }
                })}>{$translate('room.joinVideo')}</button
            >
          {:else}
            <button
              class="primary"
              data-testid="room-create-audio"
              disabled={useCallRoomStore().busy}
              onclick={() =>
                act(async () => {
                  await useCallRoomStore().create('audio');
                  modal = '';
                })}>{$translate('room.createAudio')}</button
            >
            <button
              class="primary"
              data-testid="room-create-video"
              disabled={useCallRoomStore().busy}
              onclick={() =>
                act(async () => {
                  await useCallRoomStore().create('video');
                  modal = '';
                })}>{$translate('room.createVideo')}</button
            >
          {/if}
        {:else if $state.selected}{#key $state.selected.publicKey}<ContactDetails
              publicKey={$state.selected.publicKey}
              onopen={async (contact) => {
                modal = '';
                await openContactChat(contact);
              }}
            />{/key}<button
            class="settings-item"
            onclick={() => act(() => chats.muteChat($state.selected!.id))}>Mute conversation</button
          ><button
            class="settings-item danger-text"
            onclick={() =>
              act(async () => {
                await chats.blockChat($state.selected!.id);
                modal = '';
              })}>Block contact</button
          ><button
            class="settings-item danger-text"
            onclick={() =>
              act(async () => {
                await chats.deleteChat($state.selected!.id);
                modal = '';
              })}>Delete conversation</button
          >{/if}
        {#if modalError}<p role="alert" class="error">{modalError}</p>{/if}
      </div>
    </div>
  {/if}
{/if}
{#if actionMessage}{#key actionMessage.id}<MessageActions
      message={actionMessage}
      x={contextPosition.x}
      y={contextPosition.y}
      onaction={messageAction}
      onclose={closeMessageActions}
      onreact={(emoji, message) => {
        contextMessage = '';
        void act(() => messages.addReaction(message.chatId, message.id, emoji));
      }}
    />{/key}{/if}
<CallOverlay />

<style>
  .group-choices {
    display: grid;
    gap: 12px;
    margin-top: 12px;
  }
  .group-choices button { min-height: 48px; }
</style>
