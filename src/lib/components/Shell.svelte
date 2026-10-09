<script lang="ts">
  import { orderThreadMessages } from '#src/utils/threadMessageOrder.ts';
  import ModalFrame from './ModalFrame.svelte';
  import GroupProfileFields from './GroupProfileFields.svelte';
  import MessageInfo from './MessageInfo.svelte';
  import ThreadHeader from './ThreadHeader.svelte';
  import PinnedMessage from './PinnedMessage.svelte';
  import type { PrivateGroupPin } from '#src/stores/nostr/privateGroupPins.ts';
  import ThreadSearch from './ThreadSearch.svelte';
  import ComposerContext from './ComposerContext.svelte';
  import MessageReply from './MessageReply.svelte';
  import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
  import ForwardMessagePicker from './ForwardMessagePicker.svelte';
  import ThreadTimeline from './ThreadTimeline.svelte';
  import MessageRow from './MessageRow.svelte';
  import MessageComposer from './MessageComposer.svelte';
  import DateDivider from './DateDivider.svelte';
  import MediaUploadConfirmation from './MediaUploadConfirmation.svelte';
  import { chatDate } from '#src/utils/chatDate.ts';
  import { messagePresentation, messageMenuPosition } from '#src/utils/messagePresentation.ts';
  import {
    isAndroidRelayNotificationSupported,
    createAndroidNotificationConversationSignature,
    refreshAndroidRelayNotificationListener,
    startAndroidRelayNotificationListeners,
    ingestPendingAndroidRelayNotificationEvents,
    clearAndroidRelayNotificationForChat,
  } from '#src/services/androidRelayNotificationService.ts';
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import PublicGroupDialog from './public/PublicGroupDialog.svelte';
  import PublicGroupThread from './public/PublicGroupThread.svelte';
  import PublicGroupRow from './PublicGroupRow.svelte';
  import { publicGroupMatches } from '#src/stores/nostr/publicGroupSearchRuntime.ts';
  import { decodeRoomLink, encodeRoomLink } from '#src/stores/nostr/publicGroups.ts';
  let newPublicGroup = false;
  function openPublicGroup(link: string) {
    void goto(`/public/${encodeRoomLink(decodeRoomLink(link))}`);
  }
  import GroupSeedBackup from './GroupSeedBackup.svelte';
  import GroupRestore from './GroupRestore.svelte';
  let groupFlow: 'choose' | 'details' | 'backup' | 'restore' = 'choose';
  import { onMount, onDestroy, tick } from 'svelte';
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
    createComposerUpload,
    appendUploadLink,
    draftAttachments,
  } from '#src/lib/state/composerUpload.ts';
  import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
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
  import {
    buildGroupMemberMentionProfiles,
    serializeMentionDraft,
  } from '#src/utils/nostrMentions.ts';
  import Icon from './Icon.svelte';
  import StartupHistory from './StartupHistory.svelte';
  import CallOverlay from './CallOverlay.svelte';
  import { ROOM_MAX_MEMBERS } from '#src/types/callRoom.ts';
  import MessageBody from './MessageBody.svelte';
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
  let highlightedMessage = '';
  let messageLayout = readDesktopMessageLayoutPreference();
  const chats = useChatStore(),
    messages = useMessageStore(),
    nostr = useNostrStore(),
    relays = useRelayStore();
  const androidNotifications = isAndroidRelayNotificationSupported();
  let notificationsReady = false;
  $: notificationPlan = androidNotifications
    ? `${$state.contactVersion}:${createAndroidNotificationConversationSignature($state.chats)}:${JSON.stringify($state.relayEntries)}`
    : '';
  $: if (notificationsReady && notificationPlan)
    void refreshAndroidRelayNotificationListener().catch(fail);
  const publicGroups = nostr.publicGroups;
  const publicState = publicGroups.sidebar;
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
      items: chats.selectedChatId
        ? messages.getMessages(chats.selectedChatId)
        : [],
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
  let searching = false;
  let forward: Message | null = null;
  let scrollArea: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let composerInput: HTMLTextAreaElement;
  let attachmentMenu = false;
  const uploadedAttachments = new Map<string, MessageAttachmentMetadata[]>();
  const uploadContext = () => `${nostr.getLoggedInPublicKeyHex()}:${$state.selected?.id ?? ''}`;
  const uploader = createComposerUpload({
    context: uploadContext,
    serverUrl: () => nostr.getBlossomServerUrl(),
    signUploadAuthHeader: nostr.signBlossomUploadAuthHeader,
    uploaded: (attachment) => {
      const key = uploadContext();
      uploadedAttachments.set(key, [...(uploadedAttachments.get(key) ?? []), attachment]);
      draft = appendUploadLink(draft, attachment.url);
      chats.setComposerDraft(currentId, draft);
      if (fileInput) fileInput.value = '';
      modal = '';
      void tick().then(() => composerInput?.focus());
    },
    error: fail,
  });
  const uploadState = uploader.state;
  $: {
    $state.selected?.id;
    uploader.checkContext();
  }
  $: if (modal === 'upload' && !$uploadState.file) modal = '';
  onDestroy(() => uploader.cancel());
  function cancelUpload() {
    uploader.cancel();
    modal = '';
    if (fileInput) fileInput.value = '';
  }
  $: displayedMessages = orderThreadMessages($state.thread.items, (message) => message);
  let inspectedMessage: Message | null = null;
  let contextMessage = '';
  let contextPosition = { x: 0, y: 0 };
  let contextTrigger: HTMLElement | null = null;
  $: actionMessage = $state.thread.items.find(
    (message) => message.id === contextMessage && !message.meta.deleted,
  );
  function showMessageActions(message: Message, event: MouseEvent) {
    if (message.meta.deleted) return;
    event.preventDefault();
    contextTrigger =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.message-menu-trigger')
        : null;
    contextPosition = messageMenuPosition(event);
    contextMessage = message.id;
  }
  function closeMessageActions() {
    contextMessage = '';
    contextTrigger?.focus({ preventScroll: true });
    contextTrigger = null;
  }
  let groupPin: PrivateGroupPin | null = null;
  let pinBusy = false;
  let pinRevision = 0;
  let pinRepairKey = '';
  $: pinGroup = $state.selected?.type === 'group' ? $state.selected.publicKey : '';
  $: void refreshGroupPin(pinGroup, $state.contactVersion, $state.thread.items);
  $: canPin = Boolean(groupPin?.group === pinGroup && groupPin?.canPin);
  async function refreshGroupPin(group: string, _version: number, _items: Message[]) {
    const revision = ++pinRevision;
    if (groupPin?.group !== group) groupPin = null;
    if (!group) return;
    const result = await nostr.privateGroupPins.read(group).catch(() => null);
    if (revision !== pinRevision || group !== pinGroup) return;
    groupPin = result;
    const repairKey = `${nostr.getLoggedInPublicKeyHex()}:${group}:${result?.eventId}`;
    if (result?.eventId && !result.available && pinRepairKey !== repairKey) {
      pinRepairKey = repairKey;
      void nostr
        .repairMissingMessageDependency(group, result.eventId, {
          reason: 'reply-open',
          immediate: true,
          referenceCreatedAt: result.createdAt,
        })
        .then(() => {
          if (group === pinGroup)
            void refreshGroupPin(group, $state.contactVersion, $state.thread.items);
        })
        .catch(() => {});
    }
  }
  async function setGroupPin(eventId: string | null) {
    if (!pinGroup || pinBusy) return;
    const group = pinGroup;
    pinBusy = true;
    try {
      await act(() => nostr.privateGroupPins.set(group, eventId));
      await refreshGroupPin(pinGroup, $state.contactVersion, $state.thread.items);
    } finally {
      pinBusy = false;
    }
  }
  async function openPinnedMessage() {
    const pin = groupPin;
    if (!pin?.eventId || pin.group !== $state.selected?.publicKey) return;
    nearBottom = false;
    await act(async () => {
      let target = await messages.ensureMessageLoadedByEventId(pin.group, pin.eventId);
      if (!target) {
        await nostr.repairMissingMessageDependency(pin.group, pin.eventId, {
          reason: 'reply-open',
          immediate: true,
          force: true,
          referenceCreatedAt: pin.createdAt,
        });
        target = await messages.ensureMessageLoadedByEventId(pin.group, pin.eventId);
      }
      if (pin.group !== $state.selected?.publicKey) return;
      if (!target) throw new Error('Pinned message is not available in your group history.');
      await jump(target.id);
    });
  }
  async function messageAction(action: string, message: Message) {
    contextMessage = '';
    if (action === 'pin' || action === 'unpin') {
      await setGroupPin(action === 'unpin' ? null : message.eventId);
    } else if (action === 'reply') {
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
    } catch {
      /* Recorded delivery statuses remain available without contact metadata. */
    }
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
        (message) =>
          message.sender !== 'me' && (!unreadBoundary || message.sentAt > unreadBoundary),
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
  let scrollTop = 0;
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
  $: publicLink = $page.url.pathname.startsWith('/public/') ? $page.url.pathname.slice(8) : '';
  $: routedChatId = section === 'chats' ? $page.url.pathname.split('/')[2] : undefined;
  $: if (routedChatId && $state.chatIds.has(routedChatId) && $state.selected?.id !== routedChatId)
    chats.selectChat(routedChatId);
  $: mobileThread =
    section === 'contacts'
      ? Boolean(contactSelectedKey)
      : section === 'chats' && (/^\/chats\/[^/]+/.test($page.url.pathname) || !!publicLink);
  $: if ($state.selected?.id && $state.selected.id !== currentId) {
    currentId = $state.selected.id;
    draft = chats.getComposerDraft(currentId);
    reply = null;
    editing = null;
    beforeEdit = null;
    void loadThread(currentId);
  }
  $: visibleChatId =
    section === 'chats' && !publicLink && !showRequests && (!mobileViewport || mobileThread)
      ? ($state.selected?.id ?? null)
      : null;
  $: nostr.setAppLifecycleRouteChatId(visibleChatId);
  $: if (notificationsReady && visibleChatId)
    void clearAndroidRelayNotificationForChat(visibleChatId).catch(fail);
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
    if (node && nearBottom && !loadingOlder) {
      node.scrollTop = node.scrollHeight;
      void markVisibleReactions();
    }
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
    nearBottom = true;
    await messages.loadMessages(id);
    await tick();
    if (currentId === id) scrollToBottom(scrollArea);
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
        await nostr.publishPrivateContactList(relays.relays).catch((error) => {
          console.warn('Could not sync the updated contact list to relays', error);
        });
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
    const typed = draft;
    const text = serializeMentionDraft(draft, mentionProfiles);
    const uploadKey = uploadContext();
    const attachments = draftAttachments(text, uploadedAttachments.get(uploadKey));
    const editedMessage = editing;
    const originalReply = reply;
    draft = '';
    if (!editedMessage) chats.clearComposerDraft(chat.id);
    nearBottom = true;
    try {
      if (editedMessage) await messages.editMessage(chat.id, editedMessage.id, text);
      else await messages.sendMessage(chat.id, text, originalReply, { attachments });
      uploadedAttachments.delete(uploadKey);
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
            attachments,
            continueFromMessageId: e.localMessageId ?? undefined,
          });
        } catch (cause) {
          fail(cause);
        }
      } else {
        // Restore what the user typed (@handles, not nostr: URIs) and keep it
        // as the chat's draft, which was cleared optimistically above.
        if (currentId === chat.id) draft = typed;
        if (!editedMessage) chats.setComposerDraft(chat.id, typed);
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
      // The Vue-to-Svelte bridge batches notifications. Wait for the actual
      // window, not a fixed number of frames: busy/backgrounded tabs can take
      // longer. Follow the latest first row if ingestion/deletion changes it,
      // and stop waiting if the user navigates away.
      while (
        current() &&
        $state.thread.items[0]?.id !== messages.getMessages(chatId)[0]?.id
      )
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await tick();
      if (!current()) return;
      if (anchor?.isConnected && anchorOffset !== null)
        node.scrollTop +=
          anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - anchorOffset;
      else node.scrollTop = previousTop + Math.max(0, node.scrollHeight - previousHeight);
      scrollTop = node.scrollTop;
      void markVisibleReactions();
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
      ...buildMessageReplyPreviewContent(message.text, message.meta),
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
  async function jump(id: string, signal?: AbortSignal) {
    const chatId = $state.selected?.id;
    if (!chatId) return;
    nearBottom = false;
    const target = await messages.ensureMessageLoaded(chatId, id);
    if (!target || $state.selected?.id !== chatId || signal?.aborted) return;
    await tick();
    if ($state.selected?.id !== chatId || signal?.aborted) return;
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
  function prepareUpload(file?: File) {
    if (!file || !$state.selected || busy) return;
    uploader.choose(file);
    modal = 'upload';
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
    return chatDate(value, $locale);
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
    let disposed = false;
    // Saved public rooms are local account data, just like the private chat list.
    // Do not wait for relay synchronization before displaying them.
    void publicGroups.init().catch((error) => {
      if (!disposed) fail(error);
    });
    let pendingNotificationChat: string | null | undefined;
    const drainNotifications = () => {
      if (notificationsReady) void ingestPendingAndroidRelayNotificationEvents().catch(fail);
    };
    const openNotification = (pubkey: string | null) => {
      if (!notificationsReady) {
        pendingNotificationChat = pubkey;
        return;
      }
      void goto(pubkey ? `/chats/${pubkey}` : '/chats');
      drainNotifications();
    };
    const stopNotifications = startAndroidRelayNotificationListeners(
      openNotification,
      drainNotifications,
    );
    void nostr
      .initializeSessionState()
      .then(() => {
        if (disposed) return;
        notificationsReady = androidNotifications;
        if (pendingNotificationChat !== undefined) openNotification(pendingNotificationChat);
        drainNotifications();
      })
      .catch(fail);
    return () => {
      window.removeEventListener(DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT, updateLayout);
      disposed = true;
      notificationsReady = false;
      stopNotifications();
      publicGroups.stop();
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
    class:group-thread={Boolean(publicLink) || $state.selected?.type === 'group'}
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
              modal = 'group';
              groupFlow = 'choose';
              contactName = '';
              groupMembers = '';
              groupAbout = '';
              modalError = '';
              menu = false;
            }}>New private group</button
          ><button
            onclick={() => {
              newPublicGroup = true;
              menu = false;
            }}>New public group</button
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
          {#each $publicState.rooms.filter( (item) => publicGroupMatches(item.room, query) ) as item (item.address)}
            <PublicGroupRow
              room={item.room}
              active={!!publicLink && $publicState.address === item.address}
              onselect={() => {
                query = '';
                openPublicGroup(encodeRoomLink(item.room));
              }}
            />
          {/each}
          {#each $state.chats as chat (chat.id)}
            <ChatRow
              {chat}
              ownPublicKey={nostr.getLoggedInPublicKeyHex() ?? ''}
              active={!publicLink && $state.selected?.id === chat.id}
              onselect={open}
              onaction={chatAction}
            />
          {/each}
          <ProfileSearchResults
            bind:this={profileSearch}
            includePublicGroups
            joinedAddresses={$publicState.rooms.map((item) => item.address)}
            ongroup={(room) => {
              query = '';
              openPublicGroup(encodeRoomLink(room));
            }}
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
      {#if publicLink}
        {#key publicLink}<PublicGroupThread
            link={publicLink}
            onauthor={openAuthor}
            onforward={(message) => {
              forward = message;
              modal = 'forward';
            }}
            {messageLayout}
          />{/key}
      {:else if section === 'contacts'}
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
        <ThreadHeader
          name={selectedName}
          subtitle={$state.selected.type === 'group'
            ? 'Private group'
            : 'Last active ' +
              new Date($state.selected.lastMessageAt || Date.now()).toLocaleString($locale, {
                hour: 'numeric',
                minute: '2-digit',
                month: 'short',
                day: 'numeric',
              })}
          publicKey={$state.selected.publicKey}
          picture={String($state.selected.meta.picture ?? '')}
          privateGroup={$state.selected.type === 'group'}
          onopen={openProfile}
          oncopy={$state.selected.type === 'user'
            ? () =>
                void act(async () => {
                  await navigator.clipboard.writeText(nostr.encodeNpub($state.selected!.publicKey));
                  Notify.create({ message: $translate('common.copiedLabel', { label: 'npub' }) });
                })
            : undefined}
          onback={() => {
            mobileThread = false;
            chats.setVisibleChatId(null);
            goto('/chats');
          }}
        >
          {#snippet actions()}
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
          {/snippet}
        </ThreadHeader>
        {#if groupPin?.group === pinGroup && groupPin?.eventId}
          <PinnedMessage
            text={groupPin.text}
            onopen={() => void openPinnedMessage()}
            onunpin={canPin ? () => void setGroupPin(null) : undefined}
            busy={pinBusy}
          />
        {/if}
        {#if searching}
          {#key $state.selected.id}
            <ThreadSearch
              onsearch={(query) => messages.searchMessages($state.selected!.id, query)}
              onselect={jump}
              onclear={() => (highlightedMessage = '')}
              onclose={() => (searching = false)}
            />
          {/key}
        {/if}
        <ThreadTimeline
          bind:element={scrollArea}
          chatId={$state.selected.id}
          publicKey={$state.selected.publicKey}
          onmount={mountThread}
          firstDay={$state.thread.items[0] ? date($state.thread.items[0].sentAt) : ''}
          hasOlder={Boolean($state.thread.pagination?.hasOlder)}
          hasNewer={Boolean($state.thread.pagination?.hasNewer)}
          loading={loadingOlder}
          bind:nearBottom
          onolder={() => void act(older)}
          onnewer={() => void act(() => messages.loadNewerMessages($state.selected!.id))}
          onlatest={() =>
            void act(async () => {
              if ($state.selected) await messages.loadMessages($state.selected.id);
              nearBottom = true;
              await tick();
              scrollToBottom(scrollArea);
            })}
          onscroll={() => {
            contextMessage = '';
            scrollTop = scrollArea.scrollTop;
            void markVisibleReactions();
          }}
        >
          {#if $state.selected.type === 'user' && $state.selected.publicKey === nostr.getLoggedInPublicKeyHex() && !$state.thread.pagination?.hasOlder && !loadingOlder}
            <blockquote class="self-chat-quote">
              <i
                >“I often have long conversations with myself, and I am so clever that sometimes I
                don't understand a single word of what I am saying”</i
              >
              <br /><br /><small
                >DMs to yourself are end-to-end encrypted with no metadata exposed, just like DMs to
                others.</small
              >
            </blockquote>
          {/if}
          {#each displayedMessages as message, index (message.id)}
            {@const author = messageAuthor(
              message,
              $state.selected,
              mentionProfiles,
              $state.profiles,
              $translate('common.you'),
            )}
            {@const presentation = messagePresentation(
              message,
              displayedMessages[index - 1],
              displayedMessages[index + 1],
              $locale,
            )}
            {#if presentation.startsDay}<DateDivider label={presentation.dayLabel} />{/if}
            {#if message.id === firstUnreadId}<div
                class="unread-divider"
                data-testid="thread-unread-separator"
              >
                {$translate('relays.unreadMessages')}
              </div>{/if}
            <MessageRow
              {message}
              {author}
              bubbleLayout={messageLayout === 'bubbles'}
              continuesSender={presentation.continuesSender}
              senderContinues={presentation.senderContinues}
              dayLabel={presentation.dayLabel}
              highlighted={highlightedMessage === message.id}
              contextOpen={contextMessage === message.id}
              contactName={$state.selected?.name ?? ''}
              contactRelayUrls={selectedRelayUrls}
              onauthor={openAuthor}
              onactions={(event) =>
                contextMessage === message.id
                  ? closeMessageActions()
                  : showMessageActions(message, event)}
            >
              {#if message.meta.reply && !message.meta.deleted}<MessageReply
                  reply={message.meta.reply}
                  onclick={() => act(() => openReplyTarget(message))}
                />{/if}
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
            </MessageRow>
          {:else}<div class="empty-thread">
              <Icon name="lock" />
              <p>This is the beginning of your private conversation.</p>
            </div>{/each}
        </ThreadTimeline>
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
        {#if chats.isRequestChat($state.selected.id)}<div class="request-banner">
            Message request <button
              class="primary"
              onclick={() => act(() => chats.acceptChat($state.selected!.id))}
              >{$translate('Accept')}</button
            ><button class="danger" onclick={() => act(() => chats.blockChat($state.selected!.id))}
              >{$translate('Block')}</button
            >
          </div>{/if}
        <ComposerContext
          {reply}
          editing={Boolean(editing)}
          oncancel={() => {
            if (editing) finishEditing();
            else reply = null;
          }}
        />
        <MessageComposer
          bind:draft
          bind:input={composerInput}
          bind:fileInput
          bind:emoji
          bind:attachmentMenu
          {busy}
          attachDisabled={Boolean(editing)}
          onsend={() => void send()}
          onfile={prepareUpload}
          {mentionProfiles}
          onchange={() => {
            if (!editing) chats.setComposerDraft(currentId, draft);
          }}
        />
      {:else}<div class="welcome-empty">
          <div class="welcome-mark">...</div>
          <p>{$translate('chat.selectChatStartMessaging')}</p>
        </div>{/if}
    </main>
  </div>
  {#if modal}
    <ModalFrame
      title={modal === 'info'
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
      label={modal}
      onclose={() => (modal === 'upload' ? cancelUpload() : (modal = ''))}
    >
      {#if modal === 'info' && inspectedMessage}<MessageInfo
          message={inspectedMessage}
          onretry={async (status) => {
            await nostr.retryDirectMessageRelay(
              Number(inspectedMessage!.id),
              status.relay_url,
              status.scope as 'recipient' | 'self',
            );
            if (inspectedMessage)
              inspectedMessage =
                messages
                  .getMessages(inspectedMessage.chatId)
                  .find((message) => message.id === inspectedMessage?.id) ?? inspectedMessage;
          }}
        />
      {:else if modal === 'upload'}<MediaUploadConfirmation
          fileName={$uploadState.file?.name ?? ''}
          serverUrl={nostr.getBlossomServerUrl()}
          busy={$uploadState.busy}
          oncancel={cancelUpload}
          onconfirm={() => void uploader.upload()}
        />
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
            modal = 'group';
            groupFlow = 'choose';
            contactName = '';
            groupMembers = '';
            groupAbout = '';
          }}>Create a private group</button
        >
      {:else if modal === 'group'}
        {#if groupFlow === 'choose'}
          <div class="group-choices">
            <button class="primary" onclick={() => (groupFlow = 'details')}
              >Generate new group</button
            >
            <button class="outline" onclick={() => (groupFlow = 'restore')}>Restore group</button>
          </div>
        {:else if groupFlow === 'restore'}
          <GroupRestore
            onback={() => (groupFlow = 'choose')}
            onrestored={async (key) => {
              await chats.reload();
              modal = '';
              await goto(`/chats/${key}`);
            }}
          />
        {:else if groupFlow === 'backup'}
          <GroupSeedBackup relayUrls={relays.relays} {busy} onverified={createGroup} />
        {:else}<GroupProfileFields
            bind:name={contactName}
            bind:about={groupAbout}
            showPicture={false}
            contextKey="new-private-group"
            disabled={busy}
          /><label
            >{$translate('Members')}<textarea
              bind:value={groupMembers}
              placeholder="Public keys or NIP-05 addresses, separated by commas"></textarea></label
          >
          <p>Members receive an encrypted invitation.</p>
          <button class="outline" disabled={busy} onclick={() => (groupFlow = 'choose')}
            >Back</button
          >
          <button
            class="primary"
            disabled={busy || !contactName}
            onclick={() => (groupFlow = 'backup')}>Continue</button
          >
        {/if}
      {:else if modal === 'forward'}<ForwardMessagePicker
          destinations={[
            ...$state.chats.map((chat) => ({
              id: chat.id,
              name: chat.name,
              publicKey: chat.publicKey,
              kind: chat.type,
            })),
            ...$publicState.rooms.map(({ room }) => ({
              id: room.address,
              name: room.name,
              publicKey: room.owner,
              kind: 'public' as const,
            })),
          ]}
          onselect={(id, publicGroup) =>
            act(async () => {
              if (forward) {
                if (publicGroup) await publicGroups.forwardMessage(id, forward);
                else await messages.forwardMessage(id, forward);
              }
              modal = '';
            })}
        />
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
    </ModalFrame>
  {/if}
{/if}
{#if actionMessage}{#key actionMessage.id}<MessageActions
      message={actionMessage}
      x={contextPosition.x}
      y={contextPosition.y}
      allowedActions={[
        'reply',
        'copy',
        'forward',
        'edit',
        'info',
        'delete',
        ...(canPin && !pinBusy && actionMessage.eventId && !actionMessage.meta.deleted
          ? [
              groupPin?.eventId &&
              (groupPin.eventId === actionMessage.eventId ||
                (typeof actionMessage.meta.edited === 'object' &&
                  actionMessage.meta.edited.previousEventIds.includes(groupPin.eventId)))
                ? 'unpin'
                : 'pin',
            ]
          : []),
      ]}
      onaction={messageAction}
      onclose={closeMessageActions}
      onreact={(emoji, message) => {
        contextMessage = '';
        void act(() => messages.addReaction(message.chatId, message.id, emoji));
      }}
    />{/key}{/if}
<CallOverlay />

{#if newPublicGroup}
  <PublicGroupDialog onclose={() => (newPublicGroup = false)} onopen={openPublicGroup} />
{/if}

<style>
  .group-choices {
    display: grid;
    gap: 12px;
    margin-top: 12px;
  }
  .group-choices button {
    min-height: 48px;
  }
</style>
