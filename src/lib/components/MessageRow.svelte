<script lang="ts">
  import type { Snippet } from 'svelte';
  import { messagePress } from '#src/lib/actions/messagePress.ts';
  import type { Message } from '#src/types/chat.ts';
  import { locale } from '#src/i18n.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import MessageRelayStatus from './MessageRelayStatus.svelte';
  import MessageReactions from './MessageReactions.svelte';
  export let message: Message;
  export let author: { name: string; picture?: string };
  export let authorLabel: Snippet | undefined = undefined;
  export let allowAvatar = true;
  export let bubbleLayout = false;
  export let continuesSender = false;
  export let senderContinues = false;
  export let dayLabel: string;
  export let highlighted = false;
  export let contextOpen = false;
  export let contactName = '';
  export let contactRelayUrls: string[] = [];
  export let publicGroup = false;
  export let onreaction: ((emoji: string, remove: boolean) => Promise<void>) | undefined =
    undefined;
  export let reactionsReadonly = false;
  export let onretry: ((url: string) => Promise<void>) | undefined = undefined;
  export let onauthor: (key: string) => void;
  export let onactions: ((event: MouseEvent) => void) | undefined = undefined;
  export let children: Snippet;
</script>

{#snippet name()}{#if authorLabel}{@render authorLabel()}{:else}{author.name}{/if}{/snippet}
<article
  class="message-row"
  class:context-open={contextOpen}
  class:highlighted
  class:sender-continuation={continuesSender}
  class:sender-continues={senderContinues}
  class:own={message.sender === 'me'}
  id="message-{message.id}"
  data-testid={publicGroup ? 'public-message' : 'message-bubble'}
  data-event-id={message.eventId ?? message.id}
  data-chat-public-key={message.chatId}
  data-author-public-key={message.authorPublicKey}
  data-day-label={dayLabel}
  oncontextmenu={message.meta.deleted ? undefined : onactions}
  use:messagePress={Boolean(onactions) && !message.meta.deleted}
>
  {#if bubbleLayout}
    {#if !senderContinues}<button
        class="bubble-avatar"
        data-testid="thread-author-profile-link"
        aria-label={`Open profile: ${author.name}`}
        onclick={() => onauthor(message.authorPublicKey)}
      >
        <Avatar
          publicKey={allowAvatar ? message.authorPublicKey : ''}
          picture={allowAvatar ? (author.picture ?? '') : ''}
          name={author.name}
          size={38}
          eager
        />
      </button>{/if}
  {:else}
    <button
      class="message-author"
      data-testid="thread-author-profile-link"
      onclick={() => onauthor(message.authorPublicKey)}
    >
      <Avatar
        publicKey={allowAvatar ? message.authorPublicKey : ''}
        picture={allowAvatar ? (author.picture ?? '') : ''}
        name={author.name}
        size={36}
        eager
      />
      <strong>{@render name()}</strong>
    </button>
  {/if}
  <div class="message-content">
    {#if bubbleLayout && !continuesSender}<button
        class="bubble-author-name"
        data-testid="thread-author-name-link"
        style:color={`var(--bubble-author-${(Number.parseInt(message.authorPublicKey.slice(0, 8), 16) || 0) % 6})`}
        onclick={() => onauthor(message.authorPublicKey)}>{@render name()}</button
      >{/if}
    {@render children()}
    <div
      class:bubble-footer={bubbleLayout &&
        !message.meta.deleted &&
        Boolean(message.meta.reactions?.length)}
      class:bubble-time-only={bubbleLayout &&
        (message.meta.deleted || !message.meta.reactions?.length)}
    >
      <span class="message-time"
        >{#if message.meta.edited && !message.meta.deleted}<span data-testid="message-edited-label"
            >edited ·
          </span>{/if}{new Date(message.sentAt).toLocaleTimeString($locale, {
          hour: '2-digit',
          minute: '2-digit',
        })}{#if !message.meta.deleted}<MessageRelayStatus
            {message}
            {contactName}
            {contactRelayUrls}
            {publicGroup}
            {onretry}
          />{/if}</span
      >
      {#if message.meta.reactions?.length && !message.meta.deleted}<MessageReactions
          {message}
          ontoggle={onreaction}
          readonly={reactionsReadonly}
        />{/if}
    </div>
  </div>
  {#if onactions && !message.meta.deleted}<button
      class="icon-button message-menu-trigger"
      aria-label="Message actions"
      aria-expanded={contextOpen}
      aria-haspopup="menu"
      aria-controls={contextOpen ? 'message-context-menu' : undefined}
      onclick={onactions}><Icon name="more" /></button
    >{/if}
</article>
