<script lang="ts">
  import { STARTER_BOT } from '#src/constants/starterBot.ts';
  import { chatLinkTarget } from '#src/utils/chatLink.ts';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  import {
    handleAndroidCallAction,
    type AndroidCallAction,
  } from '#src/services/androidCallNotificationService.ts';
  import { orderThreadMessages } from '#src/utils/threadMessageOrder.ts';
  import ModalFrame from './ModalFrame.svelte';
  import GroupCallNameFields from './GroupCallNameFields.svelte';
  import ContactIdentifierInput from './ContactIdentifierInput.svelte';
  import GroupProfileFields from './GroupProfileFields.svelte';
  import MessageInfo from './MessageInfo.svelte';
  import ThreadHeader from './ThreadHeader.svelte';
  import PinnedMessage from './PinnedMessage.svelte';
  import PinnedMessagePreview from './PinnedMessagePreview.svelte';
  import type { PrivateGroupPin } from '#src/stores/nostr/privateGroupPins.ts';
  import ThreadSearch from './ThreadSearch.svelte';
  import ComposerContext from './ComposerContext.svelte';
  import MessageReply from './MessageReply.svelte';
  import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
  import ForwardMessagePicker from './ForwardMessagePicker.svelte';
  import ThreadTimeline from './ThreadTimeline.svelte';
  import MessageRow from './MessageRow.svelte';
  import { scrollThreadToLatest } from '#src/lib/actions/threadPosition.ts';
  import MessageComposer from './MessageComposer.svelte';
  import DateDivider from './DateDivider.svelte';
  import MediaUploadConfirmation from './MediaUploadConfirmation.svelte';
  import { chatDate } from '#src/utils/chatDate.ts';
  import {
    isRtlDocument,
    sidebarKeyDelta,
    sidebarWidthFromPointer,
  } from '#src/utils/sidebarResize.ts';
  import {
    formatUnreadChatBadgeLabel,
    formatUnreadDocumentTitle,
  } from '#src/utils/unreadChatBadge.ts';
  import { messagePresentation, messageMenuPosition } from '#src/utils/messagePresentation.ts';
  import {
    isAndroidRelayNotificationSupported,
    createAndroidNotificationConversationSignature,
    refreshAndroidRelayNotificationListener,
    initializeAndroidRelayNotificationsAfterLogin,
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
  import { coalesceStore } from '#src/lib/state/coalesceStore.ts';
  const page = toStore(() => ({ url: routeState.url }));
  import { countUnseenReactionsForAuthor } from '#src/utils/messageReactions.ts';
  import { useChatStore } from '#src/stores/chatStore.svelte.ts';
  import { useMessageStore } from '#src/stores/messageStore.svelte.ts';
  import { useNostrStore } from '#src/stores/nostrStore.svelte.ts';
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
  import {
    readTopLevelBunkerLoginQueryParam,
    removeTopLevelBunkerLoginQueryParam,
    ALREADY_LOGGED_IN_BUNKER_MESSAGE,
  } from '#src/utils/bunkerLoginQuery.ts';
  import ActionFeedback from './ActionFeedback.svelte';
  import {
    actionFeedback,
    reportActionFeedback,
    showIncomingMessageBanner,
    Dialog,
  } from '#src/lib/platform/ui.ts';
  import type { SavedPublicRoom } from '#src/services/publicGroupData.ts';
  import { notificationConversationPath } from '#src/utils/notificationConversation.ts';
  import { requestBrowserNotificationsAfterLogin } from '#src/utils/browserNotificationPreference.ts';
  import { requestAndroidRelayNotificationsAfterLogin } from '#src/services/androidRelayNotificationService.ts';
  import {
    FOREGROUND_MESSAGE_ACTIVITY_EVENT,
    readForegroundMessageActivityDetail,
  } from '#src/services/foregroundMessageActivityService.ts';
  import { updateAppBadge } from '#src/lib/platform/appBadge.ts';
  import { RecordedMessageDeliveryError } from '#src/utils/messageRelayStatus.ts';
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
  import MessageBody from './MessageBody.svelte';
  import MessageActions from './MessageActions.svelte';
  import { botCommandVisibility } from '#src/utils/botCommandVisibility.ts';
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
  function resumeAndroidNotifications() {
    if (notificationsReady && document.visibilityState === 'visible')
      void refreshAndroidRelayNotificationListener().catch(fail);
  }
  $: notificationPlan = androidNotifications
    ? `${$state.contactVersion}:${createAndroidNotificationConversationSignature($state.chats)}:${JSON.stringify($state.relayEntries)}`
    : '';
  $: if (notificationsReady && notificationPlan)
    void refreshAndroidRelayNotificationListener().catch(fail);
  const publicGroups = nostr.publicGroups;
  const publicState = publicGroups.sidebar;
  let publicProfile: SavedPublicRoom | null = null;
  $: unreadChats =
    $state.unread +
    $publicState.rooms.filter((row) => !row.blocked && (row.unreadCount ?? 0) > 0).length;
  $: publicNotificationPlan = JSON.stringify(
    $publicState.rooms.map((row) => [
      row.address,
      row.room.event.id,
      row.notificationsEnabled,
      row.muted,
      row.blocked,
    ]),
  );
  $: if (notificationsReady && publicNotificationPlan)
    void refreshAndroidRelayNotificationListener().catch(fail);
  relays.init();
  const state = coalesceStore(
    toStore(() => ({
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
        remote:
          nostr.groupHistoryState.chat === chats.selectedChatId ? nostr.groupHistoryState : null,
      },
      unread: chats.unreadChatCount,
      loaded: chats.isLoaded,
      relayEntries: relays.relayEntries,
      relayVersion: nostr.relayStatusVersion,
      contactVersion: nostr.contactListVersion,
    })),
    (value) => value.selected?.id,
  );
  let section: 'chats' | 'contacts' | 'settings' = 'chats';
  let mobileThread = false;
  let mobileViewport = matchMedia('(max-width: 767px)').matches;
  let query = '';
  let profileSearch: ProfileSearchResults | undefined;
  let contactProfileSearch: ProfileSearchResults | undefined;
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
  let chatConfirmation: { id: string; name: string; action: 'delete' | 'block' } | null = null;
  let chatConfirmationBusy = false;
  let chatConfirmationError = '';
  let contacts: ContactRecord[] = [];
  let contactsLoaded = false;
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
  let revealedBotCommands = new Set<string>();
  $: botCommandChatId = $state.selected?.id;
  $: if (botCommandChatId) revealedBotCommands = new Set();
  $: botCommands = botCommandVisibility($state.thread.items, revealedBotCommands);
  $: displayedMessages = orderThreadMessages(
    $state.thread.items.filter((message) => !botCommands.hidden.has(message.id)),
    (message) => message,
  );
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
        ? event.target.closest<HTMLElement>('.message-content')
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
  let pinPreview: { group: string; eventId: string; account: string | null } | null = null;
  let pinLoading = false;
  let pinLoadRevision = 0;
  let pinError = '';
  $: pinGroup = $state.selected?.type === 'group' ? $state.selected.publicKey : '';
  $: void refreshGroupPin(pinGroup, $state.contactVersion, $state.thread.items);
  $: canPin = Boolean(groupPin?.group === pinGroup && groupPin?.canPin);
  $: if (pinPreview && (pinPreview.group !== pinGroup || pinPreview.eventId !== groupPin?.eventId))
    closePinPreview();
  function closePinPreview() {
    pinPreview = null;
    pinLoadRevision++;
    pinLoading = false;
    pinError = '';
  }
  async function refreshGroupPin(group: string, _version: number, _items: Message[]) {
    const revision = ++pinRevision;
    if (groupPin?.group !== group) groupPin = null;
    if (!group) return;
    const result = await nostr.privateGroupPins.read(group).catch(() => null);
    if (revision !== pinRevision || group !== pinGroup) return;
    groupPin = result;
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
    if (!pin?.eventId || pin.group !== pinGroup || pinLoading) return;
    const preview = {
      group: pin.group,
      eventId: pin.eventId,
      account: nostr.getLoggedInPublicKeyHex(),
    };
    pinPreview = preview;
    pinError = '';
    if (pin.message) return;
    const revision = ++pinLoadRevision;
    const active = () =>
      pinPreview === preview && preview.account === nostr.getLoggedInPublicKeyHex();
    pinLoading = true;
    try {
      const current = await nostr.privateGroupPins.read(pin.group);
      if (!active()) return;
      if (current?.eventId !== pin.eventId) {
        closePinPreview();
        return;
      }
      if (!current.message) {
        await nostr.repairMissingMessageDependency(pin.group, pin.eventId, {
          reason: 'reply-open',
          immediate: true,
          force: true,
          referenceCreatedAt: pin.createdAt,
        });
      }
      if (active()) await refreshGroupPin(pinGroup, $state.contactVersion, $state.thread.items);
    } catch (error) {
      if (active()) pinError = (error as Error).message;
    } finally {
      if (revision === pinLoadRevision) pinLoading = false;
    }
  }
  async function messageAction(action: string, message: Message) {
    contextMessage = '';
    if (action === 'show-command' || action === 'hide-command') {
      const command = botCommands.commands.get(message.id);
      if (command) {
        const next = new Set(revealedBotCommands);
        if (action === 'show-command') next.add(command.id);
        else next.delete(command.id);
        revealedBotCommands = new Set([...next].slice(-300));
      }
      return;
    }
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
  const callState = toStore(() => ({
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
  // Paging/read-status updates publish new chat snapshots. Only rebuild the
  // mention input (and every message's formatting) when roster contents change.
  $: mentionMembers = JSON.stringify($state.selected?.meta.group_members ?? []);
  $: mentionProfiles = buildGroupMemberMentionProfiles({
    group_members: JSON.parse(mentionMembers),
  });
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
    ? displayedMessages.find(
        (message) =>
          message.sender !== 'me' && (!unreadBoundary || message.sentAt > unreadBoundary),
      )?.id
    : undefined;
  $: if (unseenReactionMessages.length) void tick().then(scheduleVisibleReactions);
  let reactionFrame = 0;
  let reactionChecksActive = true;
  function scheduleVisibleReactions() {
    if (!reactionChecksActive || reactionFrame || !unseenReactionMessages.length) return;
    reactionFrame = requestAnimationFrame(() => {
      reactionFrame = 0;
      void markVisibleReactions();
    });
  }
  onDestroy(() => {
    reactionChecksActive = false;
    cancelAnimationFrame(reactionFrame);
  });
  async function markVisibleReactions() {
    if (!unseenReactionMessages.length) return;
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
      reportActionFeedback({ type: 'negative', message: 'Unable to save reaction read status.' });
    } finally {
      ids.forEach((id) => markingReactions.delete(id));
    }
  }
  let currentId = '';
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
  $: if ((section === 'contacts' || modal === 'contact') && $state.contactVersion >= 0)
    void loadContacts();
  $: showRequests = $page.url.pathname === '/chats/requests';
  $: publicLink = $page.url.pathname.startsWith('/public/') ? $page.url.pathname.slice(8) : '';
  let chatRoutingReady = false;
  $: routedChatId = chatLinkTarget($page.url.pathname)?.pubkey;
  $: if (chatRoutingReady) void openRoutedChat($page.url.pathname);
  $: if (routedChatId && $state.chatIds.has(routedChatId) && $state.selected?.id !== routedChatId)
    chats.selectChat(routedChatId);
  async function openRoutedChat(pathname: string) {
    const target = chatLinkTarget(pathname);
    if (!target) return;
    const account = nostr.getLoggedInPublicKeyHex();
    const isCurrent = () =>
      chatRoutingReady &&
      $page.url.pathname === pathname &&
      nostr.getLoggedInPublicKeyHex() === account;
    try {
      // Login preserves the URL, but this peer may not have a local chat yet.
      // Select the destination immediately so a starter chat is not shown instead.
      chats.selectChat(target.pubkey);
      let chat = chats.chats.find((entry) => entry.id === target.pubkey);
      const needsProfile = !chat;
      if (!chat || chat.meta.deleted_locally === true) {
        const profile = getPublicProfile(target.pubkey);
        chat =
          (await chats.addContact(profile?.name || target.pubkey, target.pubkey, {
            picture: profile?.picture,
          })) ?? undefined;
      }
      if (!chat || !isCurrent()) return;
      chats.selectChat(chat.id);
      const cursor = await chats.markAsRead(chat.id);
      if (!isCurrent()) return;
      if (cursor) nostr.scheduleContactCursorPublish(chat.id, cursor);
      // Opening the conversation does not depend on metadata or relay availability.
      if (needsProfile)
        void nostr
          .refreshContactByPublicKey(chat.publicKey, chat.name, {
            refreshRelayList: true,
            relayListSeedRelayUrls: target.relays,
          })
          .catch(() => {});
    } catch (error) {
      if (isCurrent()) fail(error);
    }
  }
  $: mobileThread =
    section === 'contacts'
      ? Boolean(contactSelectedKey)
      : section === 'chats' && (/^\/chats?\/[^/]+/.test($page.url.pathname) || !!publicLink);
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
  $: if (notificationsReady && publicLink && $publicState.address)
    void clearAndroidRelayNotificationForChat($publicState.address).catch(fail);
  let historyRevision = 0;
  let historyFrame = 0;
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  function cancelScheduledHistory() {
    historyRevision++;
    cancelAnimationFrame(historyFrame);
    clearTimeout(historyTimer);
    nostr.prioritizeThreadHistory(null);
  }
  async function prioritizeVisibleThread(chatId: string | null) {
    cancelScheduledHistory();
    if (!chatId) return;
    const revision = historyRevision;
    await messages.loadMessages(chatId);
    if (revision !== historyRevision) return;
    await tick();
    if (revision !== historyRevision) return;
    // Explicit navigation must commit the cached UI before relay work starts;
    // an animation frame can otherwise beat the normal 16ms hydration batch.
    state.flush();
    await tick();
    if (revision !== historyRevision) return;
    // Give the cached thread a paint before starting relay queries/decryption.
    // Both callbacks are cancellable when another conversation is selected.
    function afterCachedRender() {
      if (revision !== historyRevision) return;
      historyTimer = setTimeout(() => {
        if (revision === historyRevision) nostr.prioritizeThreadHistory(chatId);
      }, 0);
    }
    historyFrame = requestAnimationFrame(afterCachedRender);
  }
  $: void prioritizeVisibleThread(visibleChatId);
  function mountThread(_node: HTMLDivElement) {
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
    scrollThreadToLatest(node, messages.getMessages(currentId).at(-1)?.id);
    scheduleVisibleReactions();
  }
  function fail(error: unknown) {
    if (error instanceof RecordedMessageDeliveryError) return;
    reportActionFeedback({
      type: 'negative',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  async function act(fn: () => unknown) {
    actionFeedback.set(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
  }
  async function loadThread(id: string) {
    await messages.loadMessages(id);
    // The timeline positions its first rendered window once. Later hydration preserves it.
  }
  async function open(chat: Chat) {
    if (chat.meta.deleted_locally === true) {
      const reopened = await chats.addContact(chat.name, chat.publicKey);
      if (!reopened) return;
      chat = reopened;
    }
    const alreadyVisible = chat.id === visibleChatId;
    if (!alreadyVisible) cancelScheduledHistory();
    showRequests = false;
    // The desktop sidebar stays mounted while the thread changes. Preserve any
    // search input/selection made during navigation; mobile opens a new screen.
    await goto(`/chats/${chat.id}`, { reset: mobileViewport });
    if ($page.url.pathname !== `/chats/${chat.id}`) return;
    chats.selectChat(chat.id);
    nostr.setAppLifecycleRouteChatId(chat.id);
    mobileThread = true;
    // Commit the recipient and draft before exposing the composer. The thread
    // effects already load history and mark it read without blocking navigation.
    await tick();
    // Reselecting the visible chat does not rerun the selection effect. Refresh
    // its bounded history scan too, including newly available older replies.
    if (alreadyVisible && visibleChatId === chat.id)
      void prioritizeVisibleThread(chat.id).catch(fail);
  }
  async function loadContacts() {
    const revision = ++contactLoadRevision;
    try {
      const next = await contactsService.listContacts();
      if (revision === contactLoadRevision) {
        contacts = next;
        contactsLoaded = true;
      }
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
    const text = serializeMentionDraft(draft, mentionProfiles);
    const uploadKey = uploadContext();
    const attachments = draftAttachments(text, uploadedAttachments.get(uploadKey));
    const editedMessage = editing;
    const originalReply = reply;
    draft = '';
    if (!editedMessage) chats.clearComposerDraft(chat.id);
    try {
      if (editedMessage) await messages.editMessage(chat.id, editedMessage.id, text);
      else {
        scrollThreadToLatest(scrollArea);
        await messages.sendMessage(chat.id, text, originalReply, { attachments });
      }
      uploadedAttachments.delete(uploadKey);
      if (currentId === chat.id) {
        if (editedMessage) finishEditing();
        else reply = null;
      }
    } catch (e) {
      if (currentId === chat.id) draft = text;
      fail(e);
    } finally {
      busy = false;
    }
  }
  let olderLoad: { chatId: string } | null = null;
  $: loadingOlder = Boolean(
    (olderLoad !== null && olderLoad.chatId === $state.selected?.id) ||
    $state.thread.pagination?.isLoadingOlder ||
    $state.thread.remote?.loading,
  );
  function canLoadOlder() {
    return Boolean(
      $state.selected &&
      ($state.thread.pagination?.hasOlder || $state.thread.remote?.hasOlder) &&
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
    contextMessage = '';
    node.focus({ preventScroll: true });
    const current = () =>
      chats.selectedChatId === chatId && scrollArea === node && node.isConnected;
    try {
      if (!$state.thread.pagination?.hasOlder && $state.selected?.type === 'group') {
        messages.pinMessageWindow(chatId);
        const first = messages.getMessages(chatId)[0];
        await nostr.loadOlderGroupHistory(
          chatId,
          first ? Date.parse(first.sentAt) / 1000 : Date.now() / 1000,
        );
        if (!current()) return;
        await messages.loadMessages(chatId, true);
      }
      await messages.loadOlderMessages(chatId);
      await tick();
      if (!current()) return;
      scheduleVisibleReactions();
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
    const target = await messages.ensureMessageLoaded(chatId, id);
    if (!target || $state.selected?.id !== chatId || signal?.aborted) return;
    revealedBotCommands = new Set([...revealedBotCommands, target.id].slice(-300));
    await tick();
    if ($state.selected?.id !== chatId || signal?.aborted) return;
    highlightedMessage = target.id;
    document.getElementById(`message-${target.id}`)?.scrollIntoView({ block: 'center' });
  }
  async function openReplyTarget(message: Message) {
    const preview = message.meta.reply;
    const chatId = message.chatId;
    if (!preview) return;
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
            : sidebarWidth + sidebarKeyDelta(event.key, isRtlDocument()),
      );
    }
  }
  async function chatAction(chat: Chat, action: string) {
    if (action === 'delete' || action === 'block') {
      if (chatConfirmation) return;
      chatConfirmation = { id: chat.id, name: chat.name, action };
      chatConfirmationError = '';
      return;
    }
    await act(async () => {
      if (action === 'profile') {
        await open(chat);
        openProfile();
      } else if (action === 'refresh' || action === 'refresh-group') {
        await nostr.refreshContactByPublicKey(chat.publicKey, chat.name);
        if (action === 'refresh-group') await nostr.refreshPrivateMessages();
        await chats.reload();
      } else if (action === 'notifications' && chat.type === 'group') {
        const enabled = chat.meta.notifications_enabled !== true;
        if (enabled) await enableGroupNotificationPermission();
        await chats.setGroupNotifications(chat.id, enabled);
        if (androidNotifications) {
          if (!enabled) await clearAndroidRelayNotificationForChat(chat.id);
          await refreshAndroidRelayNotificationListener();
        }
      } else if (action === 'mute')
        await (chat.meta.muted
          ? nostr.unmutePubkey(chat.id, relays.relays)
          : nostr.mutePubkey(chat.id, relays.relays));
      else if (action === 'accept') {
        await chats.acceptChat(chat.id);
        await open(chat);
      } else if (action === 'read') {
        const cursor = await chats.markAsRead(chat.id);
        if (cursor) nostr.scheduleContactCursorPublish(chat.id, cursor);
      }
    });
  }
  async function enableGroupNotificationPermission() {
    const permission = androidNotifications
      ? await requestAndroidRelayNotificationsAfterLogin()
      : await requestBrowserNotificationsAfterLogin();
    if (permission === 'denied' || permission === 'default' || permission === 'prompt')
      throw new Error('Allow notifications in your browser or device settings, then try again.');
    if (permission === 'unsupported')
      reportActionFeedback('Notifications will appear while Anagram is open on this device.');
  }
  async function publicChatAction(row: SavedPublicRoom, action: string) {
    if (action === 'delete' || (action === 'block' && !row.blocked)) {
      Dialog.create({
        title: `${action === 'delete' ? 'Delete' : 'Block'} ${row.room.name}?`,
        message:
          action === 'delete'
            ? 'Remove this public group from your chats? You can join it again using its link.'
            : 'Stop messages and notifications from this public group?',
        ok: { label: action === 'delete' ? 'Delete Chat' : 'Block' },
        cancel: { label: 'Cancel' },
      }).onOk(
        () =>
          void act(async () => {
            const selected = publicLink && $publicState.address === row.address;
            if (action === 'delete') await publicGroups.leave(row.address);
            else await publicGroups.setPreferences(row.address, { blocked: true });
            await clearAndroidRelayNotificationForChat(row.address);
            if (selected) await goto('/chats');
            if (androidNotifications) await refreshAndroidRelayNotificationListener();
          }),
      );
      return;
    }
    await act(async () => {
      if (action === 'profile') publicProfile = row;
      else if (action === 'refresh') await publicGroups.refreshRoom(row.address);
      else if (action === 'refresh-group') {
        if (row.blocked) throw new Error('Unblock this group before refreshing it.');
        if (publicLink && $publicState.address === row.address)
          await publicGroups.open(encodeRoomLink(row.room));
        else openPublicGroup(encodeRoomLink(row.room));
      } else if (action === 'read') {
        await publicGroups.markRead(row.address);
        await clearAndroidRelayNotificationForChat(row.address);
      } else {
        if (action === 'notifications') {
          const enabled = row.notificationsEnabled !== true;
          if (enabled) await enableGroupNotificationPermission();
          await publicGroups.setPreferences(row.address, { notificationsEnabled: enabled });
          if (!enabled) await clearAndroidRelayNotificationForChat(row.address);
        } else if (action === 'mute')
          await publicGroups.setPreferences(row.address, { muted: !row.muted });
        else if (action === 'block')
          await publicGroups.setPreferences(row.address, { blocked: false });
        if (androidNotifications) await refreshAndroidRelayNotificationListener();
      }
    });
  }
  async function confirmChatAction() {
    if (!chatConfirmation || chatConfirmationBusy) return;
    const { id, action } = chatConfirmation;
    chatConfirmationBusy = true;
    chatConfirmationError = '';
    try {
      if (action === 'block') await chats.blockChat(id);
      else if (!(await chats.deleteChat(id)))
        throw new Error('Could not delete this conversation. Please try again.');
      chatConfirmation = null;
    } catch (error) {
      chatConfirmationError = error instanceof Error ? error.message : String(error);
    } finally {
      chatConfirmationBusy = false;
    }
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
      if (addingInContacts) {
        await loadContacts();
        await goto(`/contacts/${found.normalizedPubkey}`);
      } else if (chat) await open(chat);
      modal = '';
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
      if (warnings.length) reportActionFeedback({ type: 'warning', message: warnings.join(' ') });
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
    let privateUnread = 0,
      groupUnread = 0;
    const stopBadge = toStore(() => chats.unreadMessageCount).subscribe((count) => {
      privateUnread = count;
      void updateAppBadge(privateUnread + groupUnread);
    });
    const stopPublicBadge = publicState.subscribe(({ rooms }) => {
      groupUnread = rooms
        .filter((row) => !row.blocked)
        .reduce((n, row) => n + (row.unreadCount ?? 0), 0);
      void updateAppBadge(privateUnread + groupUnread);
    });
    let dismissGroupNotice: (() => void) | undefined;
    const foregroundMessage = (event: Event) => {
      const detail = readForegroundMessageActivityDetail(event);
      if (
        detail?.showBanner &&
        (detail.chatPubkey.startsWith('34550:') ||
          chats.chats.some((chat) => chat.id === detail.chatPubkey && chat.type === 'group'))
      ) {
        dismissGroupNotice?.();
        dismissGroupNotice = showIncomingMessageBanner(`${detail.title}: ${detail.messageText}`);
      }
    };
    window.addEventListener(FOREGROUND_MESSAGE_ACTIVITY_EVENT, foregroundMessage);
    if (readTopLevelBunkerLoginQueryParam()) {
      removeTopLevelBunkerLoginQueryParam();
      reportActionFeedback({ message: ALREADY_LOGGED_IN_BUNKER_MESSAGE });
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
    document.addEventListener('visibilitychange', resumeAndroidNotifications);
    void chats.init().then(() => {
      if (!disposed) chatRoutingReady = true;
    });
    nostr.startAppLifecycleRuntime();
    let disposed = false;
    // Saved public rooms are local account data, just like the private chat list.
    // Do not wait for relay synchronization before displaying them.
    void publicGroups.init().catch((error) => {
      if (!disposed) fail(error);
    });
    // Call invitations expire while history restores. The call handler already
    // validates the account/token and prioritizes its signed envelope ingestion.
    const openCallNotification = (action: AndroidCallAction) => {
      if (!disposed && action.ownerPubkey === nostr.getLoggedInPublicKeyHex())
        void handleAndroidCallAction(action).catch(fail);
    };
    let pendingNotificationChat: string | null | undefined;
    const drainNotifications = () => {
      if (notificationsReady) void ingestPendingAndroidRelayNotificationEvents().catch(fail);
    };
    const openNotification = (pubkey: string | null) => {
      if (!notificationsReady) {
        pendingNotificationChat = pubkey;
        return;
      }
      void goto(pubkey ? notificationConversationPath(pubkey) : '/chats');
      drainNotifications();
    };
    const stopNotifications = startAndroidRelayNotificationListeners(
      openNotification,
      drainNotifications,
      openCallNotification,
    );
    void nostr
      .initializeSessionState()
      .then(async () => {
        if (disposed) return;
        await initializeAndroidRelayNotificationsAfterLogin().catch(fail);
        if (disposed) return;
        notificationsReady = androidNotifications;
        if (pendingNotificationChat !== undefined) openNotification(pendingNotificationChat);
        drainNotifications();
      })
      .catch(fail);
    return () => {
      actionFeedback.set(null);
      stopBadge();
      stopPublicBadge();
      window.removeEventListener(FOREGROUND_MESSAGE_ACTIVITY_EVENT, foregroundMessage);
      dismissGroupNotice?.();
      void updateAppBadge(0);
      window.removeEventListener(DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT, updateLayout);
      document.removeEventListener('visibilitychange', resumeAndroidNotifications);
      disposed = true;
      chatRoutingReady = false;
      notificationsReady = false;
      stopNotifications();
      publicGroups.stop();
      nostr.stopAppLifecycleRuntime();
      chats.setVisibleChatId(null);
      cancelScheduledHistory();
    };
  });
</script>

<svelte:window
  onresize={() => (mobileViewport = matchMedia('(max-width: 767px)').matches)}
  onfocus={() => {
    scheduleVisibleReactions();
    resumeAndroidNotifications();
  }}
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
        .some((target) => target instanceof Element && target.matches('.message-context-menu'))
    )
      contextMessage = '';
  }}
  onpointermove={(e) => {
    if (resizing) resizeTo(sidebarWidthFromPointer(e.clientX, innerWidth, isRtlDocument()));
  }}
  onpointerup={() => (resizing = false)}
  onblur={() => (resizing = false)}
/>
<svelte:head
  ><title>{formatUnreadDocumentTitle($translate('Anagram'), unreadChats)}</title></svelte:head
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
      {#if mobileViewport && !mobileThread}<ActionFeedback />{/if}
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
            onkeydown={(event) => contactProfileSearch?.handleKeydown(event)}
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
              unreadCount={item.unreadCount ?? 0}
              muted={item.muted ?? false}
              blocked={item.blocked ?? false}
              notificationsEnabled={item.notificationsEnabled ?? false}
              onaction={(action) => publicChatAction(item, action)}
              active={!!publicLink && $publicState.address === item.address}
              onselect={() => {
                if (item.blocked) {
                  reportActionFeedback('Unblock this public group using its menu.');
                  return;
                }
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
          <ProfileSearchResults
            bind:this={contactProfileSearch}
            query={contactsQuery}
            existingKeys={visibleContacts.map((contact) => contact.public_key)}
            excludedMessage="search.existingContacts"
            onselect={(profile) => {
              contactsQuery = '';
              void openSearchProfile(profile);
            }}
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
            ><Icon name={item} />{#if item === 'chats' && unreadChats}<span class="badge nav-badge"
                >{formatUnreadChatBadgeLabel(unreadChats)}</span
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
      {#if !mobileViewport || mobileThread}<ActionFeedback />{/if}
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
                })
            : undefined}
          oncopylink={$state.selected.type === 'user'
            ? () =>
                void act(async () => {
                  await navigator.clipboard.writeText(
                    `https://anagram.chat/chat/${nostr.encodeNpub($state.selected!.publicKey)}`,
                  );
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
            openLabel="View pinned message"
            onopen={() => void openPinnedMessage()}
            onunpin={canPin ? () => void setGroupPin(null) : undefined}
            busy={pinBusy || pinLoading}
          />
        {/if}
        {#if searching}
          {#key $state.selected.id}
            <ThreadSearch
              paged
              onsearch={(query, signal, before) =>
                messages.searchMessages($state.selected!.id, query, signal, before)}
              onselect={jump}
              onclear={() => (highlightedMessage = '')}
              onclose={() => (searching = false)}
            />
          {/key}
        {/if}
        {#key $state.selected.id}
          <ThreadTimeline
            bind:element={scrollArea}
            chatId={$state.selected.id}
            publicKey={$state.selected.publicKey}
            onmount={mountThread}
            firstDay={displayedMessages[0] ? date(displayedMessages[0].sentAt) : ''}
            hasOlder={Boolean($state.thread.pagination?.hasOlder || $state.thread.remote?.hasOlder)}
            historyStatus={$state.thread.remote?.loading
              ? $state.thread.remote.phase === 'keys'
                ? $translate('chat.historyKeys')
                : $translate('chat.historyMessages')
              : $state.thread.remote?.failed
                ? $translate('chat.historyRetry')
                : ''}
            hasNewer={Boolean($state.thread.pagination?.hasNewer)}
            loading={loadingOlder}
            bind:nearBottom
            onolder={() => void act(older)}
            onnewer={() => act(() => messages.loadNewerMessages($state.selected!.id))}
            onlatest={() =>
              void act(async () => {
                if ($state.selected) await messages.loadMessages($state.selected.id);
                await tick();
                scrollToBottom(scrollArea);
              })}
            onscroll={() => {
              contextMessage = '';
              scheduleVisibleReactions();
            }}
          >
            {#if $state.selected.type === 'user' && $state.selected.publicKey === nostr.getLoggedInPublicKeyHex() && !$state.thread.pagination?.hasOlder && !loadingOlder}
              <blockquote class="self-chat-quote">
                <i
                  >“I often have long conversations with myself, and I am so clever that sometimes I
                  don't understand a single word of what I am saying”</i
                >
                <br /><br /><small
                  >DMs to yourself are end-to-end encrypted with no metadata exposed, just like DMs
                  to others.</small
                >
              </blockquote>
            {:else if $state.selected.type === 'user' && $state.selected.publicKey === STARTER_BOT.publicKey && !$state.thread.pagination?.hasOlder && !loadingOlder}
              <blockquote class="self-chat-quote" data-testid="dad-bot-intro">
                <i>{$translate('chat.dadBotIntro')}</i>
                <br /><br /><small>
                  {$translate('chat.dadBotExamples')}
                  <a
                    class="bot-examples-link"
                    href="https://github.com/lnbits/anagram/bot-example"
                    target="_blank"
                    rel="noopener noreferrer"
                    onclick={(event) => {
                      event.preventDefault();
                      void act(() => openExternalHttpUrl(event.currentTarget.href));
                    }}>https://github.com/lnbits/anagram/bot-example</a
                  >
                </small>
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
        {/key}
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
          pasteContext={uploadContext}
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
            ? $translate('contacts.newConversation')
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
      {:else if modal === 'contact'}
        <ContactIdentifierInput
          bind:value={identifier}
          disabled={busy}
          searchReady={contactsLoaded}
          existingKeys={visibleContacts.map((contact) => contact.public_key)}
          onselect={(profile) => {
            if (!contactName.trim()) contactName = profile.name;
            modalError = '';
          }}
        />
        <label>{$translate('Name (optional)')}<input bind:value={contactName} /></label>
        <button class="primary" disabled={busy || !identifier} onclick={addContact}
          >{$translate('contacts.addContactAction')}</button
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
        <label
          >{$translate('room.pasteLink')}<textarea
            bind:value={identifier}
            data-testid="room-join-link"
            placeholder={$translate('room.pasteLink')}></textarea></label
        >
        {#if identifier.trim() && !parseRoomLink(identifier.trim())}<p role="alert" class="error">
            {$translate('room.error.invalidLink')}
          </p>{/if}
        <GroupCallNameFields account={nostr.getLoggedInPublicKeyHex() || ''} />
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
{#if pinPreview && groupPin?.group === pinPreview.group && groupPin.eventId === pinPreview.eventId}
  <PinnedMessagePreview onclose={closePinPreview}>
    {#if groupPin.message}
      <MessageBody
        message={groupPin.message}
        {mentionProfiles}
        oncontact={(pubkey) => {
          closePinPreview();
          void openAuthor(pubkey);
        }}
        onroom={(link) => {
          closePinPreview();
          identifier = link;
          modal = 'room';
        }}
      />
    {:else}
      <p role="status">
        {pinLoading
          ? 'Loading pinned message…'
          : 'Pinned message is not available in your group history.'}
      </p>
    {/if}
    {#if pinError}<p role="alert" class="error">{pinError}</p>{/if}
  </PinnedMessagePreview>
{/if}
{#if chatConfirmation}
  <ModalFrame
    title={chatConfirmation.action === 'delete' ? 'Delete conversation?' : 'Block conversation?'}
    busy={chatConfirmationBusy}
    onclose={() => {
      if (!chatConfirmationBusy) chatConfirmation = null;
    }}
  >
    <p>{chatConfirmation.name}</p>
    {#if chatConfirmationError}<p class="error" role="alert">{chatConfirmationError}</p>{/if}
    <div class="confirmation-actions">
      <button
        class="outline"
        disabled={chatConfirmationBusy}
        onclick={() => (chatConfirmation = null)}>{$translate('common.cancel')}</button
      >
      <button class="danger" disabled={chatConfirmationBusy} onclick={confirmChatAction}
        >{$translate(
          chatConfirmation.action === 'delete' ? 'common.delete' : 'common.block',
        )}</button
      >
    </div>
  </ModalFrame>
{/if}
{#if actionMessage}{#key actionMessage.id}<MessageActions
      message={actionMessage}
      botCommandAction={botCommands.commands.has(actionMessage.id)
        ? revealedBotCommands.has(botCommands.commands.get(actionMessage.id)!.id)
          ? 'hide-command'
          : 'show-command'
        : ''}
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
{#if publicProfile}<PublicGroupDialog
    room={publicProfile.room}
    onclose={() => (publicProfile = null)}
    onopen={openPublicGroup}
    onleave={() => {
      publicProfile = null;
      void goto('/chats');
    }}
  />{/if}

<style>
  .confirmation-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
  .group-choices {
    display: grid;
    gap: 12px;
    margin-top: 12px;
  }
  .group-choices button {
    min-height: 48px;
  }
</style>
