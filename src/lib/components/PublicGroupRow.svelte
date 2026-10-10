<script lang="ts">
  import type { PublicRoom } from '#src/stores/nostr/publicGroups.ts';
  import Avatar from './Avatar.svelte';
  import ChatListRow from './ChatListRow.svelte';
  export let room: PublicRoom;
  export let active = false;
  export let testId = 'public-chat-item';
  export let onselect: () => void;
  export let onkeydown: ((event: KeyboardEvent) => void) | undefined = undefined;
</script>

<ChatListRow {active} {onselect} {onkeydown} {testId} chatId={room.address}>
  <Avatar name={room.name} picture={room.picture} size={48} fontSize={14} publicGroup />
  <span class="chat-copy"
    ><span class="chat-top"><strong>{room.name}</strong></span><span class="chat-preview"
      >Public group</span
    ></span
  >
</ChatListRow>
