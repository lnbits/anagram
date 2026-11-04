<script lang="ts">
  import ChatRowMenu from './ChatRowMenu.svelte';
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import type { Chat } from '#src/types/chat.ts';
  import { translate, locale } from '#src/i18n.ts';
  import { chatTime } from '#src/utils/chatDate.ts';
  import { resolveChatPreviewAuthorLabel } from '#src/utils/chatPreview.ts';
  import Avatar from './Avatar.svelte';
  import ChatListRow from './ChatListRow.svelte';
  import { formatUnreadChatBadgeLabel } from '#src/utils/unreadChatBadge.ts';
  export let chat: Chat;
  export let ownPublicKey = '';
  export let active = false;
  export let onselect: (chat: Chat) => void;
  export let onaction: (chat: Chat, action: string) => void;
  $: publicKey = chat.publicKey;
  $: profile = observePublicProfile(publicKey);
  $: name =
    chat.publicKey === ownPublicKey
      ? $translate('common.self')
      : String(chat.meta.given_name || $profile?.name || chat.meta.contact_name || chat.name);
  $: author = resolveChatPreviewAuthorLabel(chat, ownPublicKey, $translate('common.you'));
  $: reactions = Math.max(0, Number(chat.meta.unseen_reaction_count) || 0);
  $: lastMessageAt = chat.lastMessageAt;
  $: time = lastMessageAt ? chatTime(lastMessageAt, $locale) : '';
  $: menuItems = [
    { action: 'profile', label: $translate('profile.viewProfile') },
    { action: 'refresh', label: $translate('profile.refreshProfile') },
    ...(chat.type === 'group'
      ? [
          { action: 'refresh-group', label: $translate('group.refreshGroupChat') },
          {
            action: 'notifications',
            label:
              chat.meta.notifications_enabled === true
                ? 'Disable notifications'
                : 'Enable notifications',
          },
        ]
      : []),
    { action: 'mute', label: $translate(chat.meta.muted ? 'common.unmute' : 'common.mute') },
    { action: 'block', label: $translate('common.block'), danger: true },
    { action: 'read', label: $translate('chat.markAsRead') },
    { action: 'delete', label: $translate('chat.deleteChat'), danger: true },
  ];
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
        >{/if}{#if chat.unreadCount}<span
          class="badge"
          aria-label={`${chat.unreadCount} unread messages`}
          >{formatUnreadChatBadgeLabel(chat.unreadCount)}</span
        >{/if}</span
    >{/if}
  {#snippet actions()}
    <ChatRowMenu items={menuItems} onaction={(action) => onaction(chat, action)} />
  {/snippet}
</ChatListRow>

<style>
  .preview-author {
    color: var(--q-primary);
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
</style>
