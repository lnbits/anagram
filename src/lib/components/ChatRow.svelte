<script lang="ts">
  import { dismissOnOutside } from '#src/lib/actions/dismissOnOutside.ts';
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import type { Chat } from '#src/types/chat.ts';
  import { translate, locale } from '#src/i18n.ts';
  import { resolveChatPreviewAuthorLabel } from '#src/utils/chatPreview.ts';
  import Avatar from './Avatar.svelte';
  import ChatListRow from './ChatListRow.svelte';
  import Icon from './Icon.svelte';
  export let chat: Chat;
  export let ownPublicKey = '';
  export let active = false;
  export let onselect: (chat: Chat) => void;
  export let onaction: (chat: Chat, action: string) => void;
  let menu = false;
  let menuTrigger: HTMLButtonElement;
  $: profile = observePublicProfile(chat.publicKey);
  $: name =
    chat.publicKey === ownPublicKey
      ? $translate('common.self')
      : String(chat.meta.given_name || $profile?.name || chat.meta.contact_name || chat.name);
  $: author = resolveChatPreviewAuthorLabel(chat, ownPublicKey, $translate('common.you'));
  $: reactions = Math.max(0, Number(chat.meta.unseen_reaction_count) || 0);
  $: time = chat.lastMessageAt
    ? new Date(chat.lastMessageAt).toLocaleTimeString($locale, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  function action(value: string) {
    menu = false;
    onaction(chat, value);
  }
</script>

<ChatListRow
  {active}
  muted={chat.meta.muted === true}
  onselect={() => onselect(chat)}
  chatId={chat.id}
  publicKey={chat.publicKey}
>
  <Avatar
    privateGroup={chat.type === 'group'}
    publicKey={chat.publicKey}
    {name}
    picture={String(chat.meta.picture ?? '')}
    size={48}
    fontSize={14}
  />
  <span class="chat-copy"
    ><span class="chat-top"
      ><strong>{name}</strong><time>{time}</time>{#if chat.meta.muted}<span
          aria-label={$translate('common.mute')}>♩</span
        >{/if}</span
    ><span class="chat-preview"
      >{#if author}<span class="preview-author" data-testid="chat-item-preview-author"
          >{author}:</span
        >
      {/if}{chat.lastMessage}</span
    ></span
  >
  {#if reactions || chat.unreadCount}<span class="row-badges"
      >{#if reactions}<span class="reaction-badge" aria-label={`${reactions} unseen reactions`}
          >♥ {reactions > 99 ? '99+' : reactions}</span
        >{/if}{#if chat.unreadCount}<span class="badge">{chat.unreadCount}</span>{/if}</span
    >{/if}
  {#snippet actions()}
    <button
      bind:this={menuTrigger}
      class="icon-button row-menu"
      aria-label="Chat actions"
      data-testid="chat-item-actions-button"
      aria-expanded={menu}
      onclick={() => (menu = !menu)}><Icon name="more" /></button
    >
    {#if menu}<div
        use:dismissOnOutside={{ dismiss: () => (menu = false), trigger: menuTrigger }}
        class="row-dropdown"
        role="menu"
        tabindex="-1"
      >
        <button role="menuitem" onclick={() => action('profile')}
          >{$translate('profile.viewProfile')}</button
        >
        <button role="menuitem" onclick={() => action('refresh')}
          >{$translate('profile.refreshProfile')}</button
        >
        {#if chat.type === 'group'}<button role="menuitem" onclick={() => action('refresh-group')}
            >{$translate('group.refreshGroupChat')}</button
          >{/if}
        <button role="menuitem" onclick={() => action('mute')}
          >{$translate(chat.meta.muted ? 'common.unmute' : 'common.mute')}</button
        >
        <button role="menuitem" class="danger-text" onclick={() => action('block')}
          >{$translate('common.block')}</button
        >
        <button role="menuitem" onclick={() => action('read')}
          >{$translate('chat.markAsRead')}</button
        >
        <button role="menuitem" class="danger-text" onclick={() => action('delete')}
          >{$translate('chat.deleteChat')}</button
        >
      </div>{/if}
  {/snippet}
</ChatListRow>

<style>
  .preview-author {
    color: var(--q-primary);
  }
  .row-menu {
    position: absolute;
    right: 6px;
    width: 28px;
    height: 28px;
    opacity: 0;
  }
  :global(.chat-row:hover) .row-menu,
  :global(.chat-row:focus-within) .row-menu {
    opacity: 1;
  }
  .row-badges {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .reaction-badge {
    background: var(--nc-reaction-accent-bg);
    color: var(--nc-reaction-accent-text);
    border-radius: 12px;
    padding: 2px 6px;
    font-size: 11px;
    white-space: nowrap;
  }
  :global(.muted) .badge {
    background: var(--nc-text-secondary);
  }
  .row-dropdown {
    position: absolute;
    top: 48px;
    right: 6px;
    background: var(--nc-menu-bg);
    color: var(--nc-text);
    box-shadow: var(--nc-shadow-md);
    border: 1px solid var(--nc-border);
    border-radius: 10px;
    padding: 6px;
    z-index: 15;
    min-width: 180px;
  }
  .row-dropdown button {
    display: block;
    padding: 9px 12px;
    width: 100%;
    text-align: left;
  }
  .row-dropdown button:hover {
    background: var(--nc-hover);
  }
  /* Touch screens of any width have no hover to reveal the menu button. */
  @media (max-width: 767px), (hover: none) {
    .row-menu {
      opacity: 1;
    }
  }
</style>
