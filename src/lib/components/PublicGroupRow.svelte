<script lang="ts">
  import type { PublicRoom } from '#src/stores/nostr/publicGroups.ts';
  import Avatar from './Avatar.svelte';
  import ChatListRow from './ChatListRow.svelte';
  import ChatRowMenu from './ChatRowMenu.svelte';
  export let room: PublicRoom;
  export let active = false;
  export let testId = 'public-chat-item';
  export let onselect: () => void;
  export let onkeydown: ((event: KeyboardEvent) => void) | undefined = undefined;
  export let unreadCount = 0;
  export let unreadMentionCount = 0;
  export let muted = false;
  export let blocked = false;
  export let notificationsEnabled = false;
  export let onaction: ((action: string) => void) | undefined = undefined;
  $: items = [
    { action: 'profile', label: 'View Profile' },
    { action: 'refresh', label: 'Refresh Profile' },
    { action: 'refresh-group', label: 'Refresh Group Chat' },
    {
      action: 'notifications',
      label: notificationsEnabled ? 'Disable notifications' : 'Enable notifications',
    },
    { action: 'mute', label: muted ? 'Unmute' : 'Mute' },
    { action: 'block', label: blocked ? 'Unblock' : 'Block', danger: !blocked },
    { action: 'read', label: 'Mark as Read' },
    { action: 'delete', label: 'Delete Chat', danger: true },
  ];
</script>

<ChatListRow {active} {onselect} {onkeydown} {testId} {muted} chatId={room.address}>
  <Avatar name={room.name} picture={room.picture} size={48} fontSize={14} publicGroup />
  <span class="chat-copy"
    ><span class="chat-top"><strong>{room.name}</strong></span><span class="chat-preview"
      >{blocked ? 'Blocked public group' : 'Public group'}</span
    ></span
  >
  {#if unreadCount > 0}<span class="row-badges"
      >{#if unreadMentionCount > 0}<span
          class="mention-badge"
          data-testid="chat-unread-mention-badge"
          aria-label="Unread mention">@</span
        >{/if}<span class="badge" aria-label={`${unreadCount} unread messages`}>{unreadCount}</span
      ></span
    >{/if}
  {#snippet actions()}{#if onaction}<ChatRowMenu
        {items}
        {onaction}
        testId="public-chat-actions-button"
      />{/if}{/snippet}
</ChatListRow>

<style>
  .row-badges {
    display: flex;
    align-items: center;
    gap: 5px;
  }
</style>
