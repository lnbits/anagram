<script lang="ts">
  import { orderThreadMessages } from '#src/utils/threadMessageOrder.ts';
  import MessageActions from '../MessageActions.svelte';
  import ComposerContext from '../ComposerContext.svelte';
  import MessageReply from '../MessageReply.svelte';
  import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
  import { getPublicProfile, observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { derived, readable } from 'svelte/store';
  import { buildMentionProfiles, serializeMentionDraft } from '#src/utils/nostrMentions.ts';
  import MessageInfo from '../MessageInfo.svelte';
  import ModalFrame from '../ModalFrame.svelte';
  import type { Message, MessageReplyPreview } from '#src/types/chat.ts';
  import { messagePresentation, messageMenuPosition } from '#src/utils/messagePresentation.ts';
  import ThreadHeader from '../ThreadHeader.svelte';
  import PinnedMessage from '../PinnedMessage.svelte';
  import ThreadSearch from '../ThreadSearch.svelte';
  import ThreadTimeline from '../ThreadTimeline.svelte';
  import MessageRow from '../MessageRow.svelte';
  import MessageComposer from '../MessageComposer.svelte';
  import DateDivider from '../DateDivider.svelte';
  import MediaUploadConfirmation from '../MediaUploadConfirmation.svelte';
  import { chatDate } from '#src/utils/chatDate.ts';
  import { locale, translate } from '#src/i18n.ts';
  export let messageLayout: string = 'bubbles';
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { roomPolicy, publicGroupShareLink } from '#src/stores/nostr/publicGroups.ts';
  import ProfileName from '../ProfileName.svelte';
  import { publicMessageState } from '#src/stores/nostr/publicMessageActions.ts';
  import {
    createComposerUpload,
    appendUploadLink,
    draftAttachments,
  } from '#src/lib/state/composerUpload.ts';
  import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
  import PublicGroupDialog from './PublicGroupDialog.svelte';
  import PublicMessage from './PublicMessage.svelte';
  import Icon from '../Icon.svelte';
  export let link: string;
  export let onauthor: (publicKey: string) => void;
  export let onforward: (message: Message) => void;
  const nostr = useNostrStore(),
    runtime = nostr.publicGroups,
    state = runtime.state;
  let details = false,
    draft = '',
    sending = false,
    error = '',
    notice = '',
    nearBottom = true;
  let paging = false;
  let searching = false;
  let highlightedMessage = '';
  let jumping = false;
  let jumpRevision = 0;
  async function jump(id: string, signal: AbortSignal) {
    const request = ++jumpRevision;
    jumping = true;
    nearBottom = false;
    try {
      const target = await runtime.jumpToMessage(id, signal);
      if (signal.aborted) return;
      if (!target) throw new Error('Message is no longer available.');
      await tick();
      if (signal.aborted) return;
      highlightedMessage = target.id!;
      document.getElementById(`message-${target.id}`)?.scrollIntoView({ block: 'center' });
    } finally {
      if (jumpRevision === request) jumping = false;
    }
  }
  let pinned: Message | null = null;
  let pinKey = '';
  let pinRevision = 0;
  let pinBusy = false;
  $: canPin = Boolean(room && room.owner === own && writable);
  $: void refreshPin(room?.event.id ?? '', $state.history, $state.messages);
  async function refreshPin(key: string, history: string, _messages: unknown[]) {
    const revision = ++pinRevision;
    const changed = key !== pinKey;
    if (changed || history) pinned = null;
    pinKey = key;
    if (!room?.pinned || history) {
      pinned = null;
      return;
    }
    const value = await runtime.pinnedMessage(changed).catch(() => null);
    if (revision === pinRevision) pinned = value;
    else if (changed && key === pinKey && !history && room?.event.id === key)
      void refreshPin(key, history, []);
  }
  async function setPin(id: string | null) {
    if (pinBusy) return;
    pinBusy = true;
    error = '';
    try {
      await runtime.pinMessage(id);
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      pinBusy = false;
    }
  }
  function openPin() {
    if (room?.pinned)
      void jump(room.pinned, new AbortController().signal).catch(
        (cause) => (error = cause.message),
      );
  }
  let reply: MessageReplyPreview | null = null;
  let editing: Message | null = null;
  let beforeEdit = '';
  let composerInput: HTMLTextAreaElement;
  $: writable = Boolean(
    room && !$state.history && !$state.stale && roomPolicy(room, own) !== 'blocked',
  );
  function cancelContext() {
    if (editing) {
      draft = beforeEdit;
      editing = null;
    } else reply = null;
  }
  async function react(emoji: string, message: Message, remove = false) {
    closeActions();
    error = '';
    try {
      await runtime.react(message.id, emoji, remove);
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  let actionMessage: Message | undefined;
  let inspectedId = '';
  let contextPosition = { x: 0, y: 0 };
  let contextTrigger: HTMLElement | null = null;
  $: inspectedMessage = displayed.find(
    (message) => message.id === inspectedId && !message.meta.deleted,
  );
  $: if (
    actionMessage &&
    !displayed.some((message) => message.id === actionMessage?.id && !message.meta.deleted)
  )
    actionMessage = undefined;
  function showActions(message: Message, event: MouseEvent) {
    if (message.meta.deleted) return;
    event.preventDefault();
    contextTrigger =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.message-menu-trigger')
        : null;
    contextPosition = messageMenuPosition(event);
    actionMessage = message;
  }
  function closeActions() {
    actionMessage = undefined;
    contextTrigger?.focus({ preventScroll: true });
    contextTrigger = null;
  }
  async function messageAction(action: string, message: Message) {
    closeActions();
    if (action === 'pin' || action === 'unpin')
      await setPin(action === 'unpin' ? null : message.id);
    if (action === 'info') inspectedId = message.id;
    if (action === 'forward') onforward(message);
    if (action === 'reply') {
      if (editing) cancelContext();
      reply = {
        messageId: message.id,
        eventId: message.id,
        ...buildMessageReplyPreviewContent(message.text, message.meta),
        sender: message.sender,
        authorName:
          message.sender === 'me'
            ? 'You'
            : getPublicProfile(message.authorPublicKey)?.name ||
              message.authorPublicKey.slice(0, 12),
        authorPublicKey: message.authorPublicKey,
        sentAt: message.sentAt,
      };
      await tick();
      composerInput?.focus();
    }
    if (action === 'edit') {
      if (!editing) beforeEdit = draft;
      editing = message;
      draft = message.text;
      await tick();
      composerInput?.focus();
    }
    if (action === 'delete') {
      try {
        await runtime.deleteMessage(message.id);
      } catch (cause) {
        error = (cause as Error).message;
      }
    }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(message.text);
        notice = 'Message copied';
      } catch {
        error = 'Could not copy message.';
      }
    }
  }
  let log: HTMLDivElement;
  let lastScrollTop = 0;
  let fileInput: HTMLInputElement;
  const uploadedAttachments = new Map<string, MessageAttachmentMetadata[]>();
  const uploadContext = () => `${nostr.getLoggedInPublicKeyHex()}:${room?.address ?? ''}`;
  const uploader = createComposerUpload({
    context: uploadContext,
    serverUrl: () => nostr.getBlossomServerUrl(),
    signUploadAuthHeader: nostr.signBlossomUploadAuthHeader,
    uploaded: (attachment) => {
      const key = uploadContext();
      uploadedAttachments.set(key, [...(uploadedAttachments.get(key) ?? []), attachment]);
      draft = appendUploadLink(draft, attachment.url);
      if (fileInput) fileInput.value = '';
    },
    error: (cause) => {
      error = (cause as Error).message;
    },
  });
  const uploadState = uploader.state;
  function cancelUpload() {
    uploader.cancel();
    if (fileInput) fileInput.value = '';
  }
  $: {
    room?.address;
    own;
    uploader.checkContext();
  }
  let mediaNotice = false;
  let creatorName = '';
  async function explainMediaTrust() {
    if (!room) return;
    mediaNotice = true;
    creatorName = '';
    const owner = room.owner,
      account = own;
    try {
      const relays = [...new Set([...room.relays, ...(await runtime.defaultRelays())])];
      const profile = await nostr.fetchUserProfileFromRelays(owner, relays);
      if (mediaNotice && room?.owner === owner && nostr.getLoggedInPublicKeyHex() === account)
        creatorName = profile?.name ?? '';
    } catch {
      // The cached profile or shortened public key remains clickable offline.
    }
  }
  $: room = $state.room;
  $: own = nostr.getLoggedInPublicKeyHex() || '';
  $: mentionKeys = room
    ? [...new Set([room.owner, ...room.trusted])].filter(
        (key) => roomPolicy(room!, key) === 'trusted',
      )
    : [];
  $: mentionProfiles = observeMentionProfiles(mentionKeys);
  function observeMentionProfiles(keys: string[]) {
    return readable(buildMentionProfiles(keys.map((publicKey) => ({ publicKey }))), (set) => {
      const releases = keys.map((key) => nostr.retainVisibleProfileTarget(key));
      const stop = derived(keys.map(observePublicProfile), (profiles) =>
        buildMentionProfiles(
          keys.map((publicKey, index) => ({
            publicKey,
            displayName: profiles[index]?.name,
          })),
        ),
      ).subscribe(set);
      return () => {
        stop();
        releases.forEach((release) => release());
      };
    });
  }
  $: entries = orderThreadMessages(
    room
      ? $state.messages
          .filter((event) => roomPolicy(room!, event.pubkey) !== 'blocked')
          .map((event) => ({ event, message: publicMessageState(event, room!, own) }))
      : [],
    ({ message }) => message,
  );
  $: visible = entries.map(({ event }) => event);
  $: displayed = entries.map(({ message }) => message);
  function date(value: string) {
    return chatDate(value, $locale);
  }
  async function latest() {
    if ($state.history) await runtime.history($state.history);
    else await runtime.open(link);
    nearBottom = true;
    await tick();
    scrollToEnd();
  }
  function scrollToEnd() {
    if (log && nearBottom && !paging && !jumping && !actionMessage)
      log.scrollTop = log.scrollHeight;
  }
  $: if (visible.length && nearBottom && !paging && !jumping) void tick().then(scrollToEnd);
  async function pageHistory(older = true) {
    if (paging || jumping || $state.loading) return;
    if (older ? !$state.more : !$state.hasNewer) return;
    paging = true;
    nearBottom = false;
    const rows = [...log.querySelectorAll<HTMLElement>('[data-event-id]')];
    const anchor = rows.find(
      (row) => row.getBoundingClientRect().bottom > log.getBoundingClientRect().top,
    );
    const offset = anchor?.getBoundingClientRect().top;
    const revision = jumpRevision;
    try {
      await (older ? runtime.older() : runtime.newer());
      await tick();
      if (revision !== jumpRevision) return;
      const retained =
        anchor && log.querySelector<HTMLElement>(`[data-event-id="${anchor.dataset.eventId}"]`);
      if (retained && offset !== undefined)
        log.scrollTop += retained.getBoundingClientRect().top - offset;
    } finally {
      paging = false;
    }
  }
  async function send() {
    if (sending) return;
    sending = true;
    error = '';
    const originalDraft = draft;
    const uploadKey = uploadContext();
    const text = serializeMentionDraft(originalDraft, $mentionProfiles);
    try {
      if (nostr.containsSessionSecret(text))
        throw new Error('This message contains your session secret.');
      if (editing) {
        await runtime.editMessage(editing.id, text);
        cancelContext();
      } else {
        await runtime.send(
          text,
          draftAttachments(text, uploadedAttachments.get(uploadKey)),
          reply?.messageId,
        );
        uploadedAttachments.delete(uploadKey);
        if (draft === originalDraft) draft = '';
        reply = null;
      }
      nearBottom = true;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      sending = false;
    }
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(publicGroupShareLink(room!));
      notice = 'Group link copied';
    } catch {
      error = 'Could not copy the group link.';
    }
  }
  onMount(() => {
    void runtime.open(link);
    const reconnect = () => {
      if (document.visibilityState === 'visible' && $state.stale && !$state.refreshing)
        void runtime.open(link);
    };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
      uploader.cancel();
      mediaNotice = false;
      runtime.stopView();
    };
  });
</script>

{#if room}
  <ThreadHeader
    name={room.name}
    picture={room.picture}
    publicGroup
    subtitle="Public group"
    label="Public group settings"
    onopen={() => (details = true)}
    onback={() => goto('/chats')}
  >
    {#snippet actions()}
      <button
        class="icon-button"
        aria-label="Search conversation"
        onclick={() => (searching = !searching)}><Icon name="search" /></button
      >
      <button class="icon-button" aria-label="Copy public group link" onclick={share}
        ><Icon name="content_copy" /></button
      >
      <button
        class="icon-button"
        aria-label="Refresh public group"
        onclick={() => runtime.open(link)}><Icon name="refresh" /></button
      >
    {/snippet}
  </ThreadHeader>
  {#if room.pinned && !$state.history}
    <PinnedMessage
      text={pinned
        ? pinned.meta.deleted
          ? 'Message deleted'
          : buildMessageReplyPreviewContent(pinned.text, pinned.meta).text
        : 'Message unavailable · Click to load'}
      onopen={openPin}
      onunpin={canPin ? () => void setPin(null) : undefined}
      busy={pinBusy}
    />
  {/if}
  {#if $state.ancestors.length}<label class="history"
      >Ownership transferred · History <select
        value={$state.history}
        disabled={$state.loading || sending}
        onchange={(event) => runtime.history(event.currentTarget.value)}
        ><option value="">Current group</option>{#each $state.ancestors as previous}<option
            value={previous.address}>{previous.name} · {previous.owner.slice(0, 8)}</option
          >{/each}</select
      ></label
    >{/if}
  {#if searching}
    {#key room.event.id + $state.history}
      <ThreadSearch
        onsearch={runtime.searchMessages}
        onselect={jump}
        onclear={() => (highlightedMessage = '')}
        onclose={() => (searching = false)}
        hint="Search downloaded messages · Up to 100 results. Load earlier messages to search more history."
      />
    {/key}
  {/if}
  <ThreadTimeline
    bind:element={log}
    chatId={room.address + $state.history}
    label="Public group messages"
    firstDay={displayed[0] ? date(displayed[0].sentAt) : ''}
    hasOlder={$state.more}
    hasNewer={$state.hasNewer}
    loading={paging || $state.loading}
    bind:nearBottom
    onolder={() => void pageHistory()}
    onnewer={() => void pageHistory(false)}
    onlatest={() => void latest()}
    onscroll={() => {
      if (log.scrollTop !== lastScrollTop) actionMessage = undefined;
      lastScrollTop = log.scrollTop;
      if (paging || jumping) return;
      if (nearBottom && $state.hasNewer) void pageHistory(false);
    }}
  >
    {#each displayed as message, index (message.id)}
      {@const event = visible[index]}
      {@const trusted = roomPolicy(room, event.pubkey) === 'trusted'}
      {@const author = {
        name:
          message.sender === 'me'
            ? $translate('common.you')
            : event.pubkey === room.owner
              ? 'Owner'
              : event.pubkey.slice(0, 12),
      }}
      {@const presentation = messagePresentation(
        message,
        displayed[index - 1],
        displayed[index + 1],
        $locale,
      )}
      {#if presentation.startsDay}<DateDivider label={presentation.dayLabel} />{/if}
      <MessageRow
        {message}
        {author}
        highlighted={highlightedMessage === message.id}
        allowAvatar={trusted || message.sender === 'me'}
        bubbleLayout={messageLayout === 'bubbles'}
        continuesSender={presentation.continuesSender}
        senderContinues={presentation.senderContinues}
        dayLabel={presentation.dayLabel}
        contextOpen={actionMessage?.id === message.id}
        onactions={(event) =>
          actionMessage?.id === message.id ? closeActions() : showActions(message, event)}
        {onauthor}
        publicGroup
        onreaction={(emoji, remove) => runtime.react(message.id, emoji, remove)}
        reactionsReadonly={!writable}
        contactName={room.name}
        contactRelayUrls={($state.ancestors.find((r) => r.address === $state.history) ?? room)
          .relays}
        onretry={(url) => runtime.retryMessage(message.eventId ?? message.id, url)}
      >
        {#snippet authorLabel()}{#if message.sender === 'me'}{$translate(
              'common.you',
            )}{:else}<ProfileName publicKey={event.pubkey} fallback={author.name} />{/if}{/snippet}
        {#if message.meta.reply && !message.meta.deleted}<MessageReply
            reply={message.meta.reply}
            onclick={() => {
              void jump(message.meta.reply!.messageId, new AbortController().signal).catch(
                (cause) => (error = cause.message),
              );
            }}
          />{/if}
        <PublicMessage
          event={message.nostrEvent!.event}
          displayMessage={message}
          {trusted}
          bubbleLayout={messageLayout === 'bubbles'}
          oncontact={onauthor}
        />
      </MessageRow>
    {:else}<div class="empty-thread">
        <Icon name="group" />
        <p>
          {$state.refreshing || $state.loading
            ? 'Loading public messages…'
            : $state.stale
              ? 'Saved messages will appear here while reconnecting.'
              : 'No messages to show. Say hello.'}
        </p>
      </div>{/each}
  </ThreadTimeline>
  {#if $state.refreshing}<p class="status" role="status">
      Syncing public group…
    </p>{:else if $state.stale}<p class="status">Offline · Showing saved messages.</p>{/if}
  {#if notice}<p class="status" role="status">{notice}</p>{/if}
  {#if error || $state.error}<p class="status error" role="alert">{error || $state.error}</p>{/if}
  {#if mediaNotice}<ModalFrame title="Media sharing" onclose={() => (mediaNotice = false)}>
      <p>
        Only trusted users can post media. Ask the group creator
        <a
          href="/chats/{room.owner}"
          style:color="var(--q-primary)"
          onclick={(event) => {
            event.preventDefault();
            mediaNotice = false;
            onauthor(room.owner);
          }}
          ><ProfileName
            publicKey={room.owner}
            givenName={creatorName}
            fallback={room.owner.slice(0, 12)}
          /></a
        > to be added to the trusted member list.
      </p>
    </ModalFrame>{/if}
  {#if $uploadState.file}<ModalFrame
      title={$translate('message.photoOrVideo')}
      label="upload"
      onclose={cancelUpload}
    >
      <MediaUploadConfirmation
        fileName={$uploadState.file.name}
        serverUrl={nostr.getBlossomServerUrl()}
        busy={$uploadState.busy}
        publicUpload
        oncancel={cancelUpload}
        onconfirm={() => void uploader.upload()}
      />
      {#if error}<p role="alert" class="error">{error}</p>{/if}
    </ModalFrame>{/if}
  <p class="status">
    {$state.history
      ? 'Earlier group history is read-only.'
      : roomPolicy(room, own) === 'blocked'
        ? 'You are blocked in this group.'
        : 'Public: anyone can read these messages.'}
  </p>
  <ComposerContext {reply} editing={Boolean(editing)} oncancel={cancelContext} />
  <MessageComposer
    mentionProfiles={$mentionProfiles}
    bind:input={composerInput}
    attachDisabled={Boolean(editing)}
    bind:draft
    bind:fileInput
    busy={sending}
    disabled={$state.stale || Boolean($state.history) || roomPolicy(room, own) === 'blocked'}
    allowAttachments={roomPolicy(room, own) === 'trusted' && !$state.history}
    onattachUnavailable={$state.history ? undefined : () => void explainMediaTrust()}
    allowFiles={false}
    accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm"
    label="Public message"
    placeholder="Write a public message"
    attachLabel="Attach public media"
    maxlength={8000}
    onsend={() => void send()}
    onfile={(file) => uploader.choose(file)}
  />
{:else}<div class="welcome-empty">
    <button class="outline" onclick={() => goto('/chats')}>Back to chats</button>
    <p>
      {$state.refreshing ? 'Loading public group…' : $state.error || 'Public group unavailable.'}
    </p>
    {#if !$state.refreshing}<button class="primary" onclick={() => runtime.open(link)}>Retry</button
      >{/if}
  </div>{/if}
{#if details && room}<PublicGroupDialog
    {room}
    onclose={() => (details = false)}
    onopen={() => {}}
    onleave={() => goto('/chats')}
  />{/if}

<svelte:window
  onclick={(event) => {
    if (
      !event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches('.message-context-menu, .message-menu-trigger'),
        )
    )
      actionMessage = undefined;
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') closeActions();
  }}
/>
{#if actionMessage}<MessageActions
    message={actionMessage}
    x={contextPosition.x}
    y={contextPosition.y}
    allowedActions={writable
      ? [
          'reply',
          'copy',
          'forward',
          'edit',
          'info',
          'delete',
          ...(canPin && !pinBusy
            ? [
                room?.pinned === actionMessage.id || pinned?.id === actionMessage.id
                  ? 'unpin'
                  : 'pin',
              ]
            : []),
        ]
      : ['copy', 'forward', 'info']}
    allowReactions={writable}
    onreact={(emoji, message) => void react(emoji, message)}
    onaction={messageAction}
    onclose={closeActions}
  />{/if}
{#if inspectedMessage}<ModalFrame
    title={$translate('common.nostrInfo')}
    label="info"
    onclose={() => (inspectedId = '')}
  >
    <MessageInfo
      message={inspectedMessage}
      onretry={(status) =>
        runtime.retryMessage(inspectedMessage!.eventId ?? inspectedMessage!.id, status.relay_url)}
    />
  </ModalFrame>{/if}

<style>
  .status,
  .history {
    padding: 8px 16px;
    margin: 0;
    font-size: 12px;
  }
  .history select {
    max-width: 60%;
    padding: 5px;
  }
</style>
