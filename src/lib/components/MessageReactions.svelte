<script lang="ts">
  import type { Message } from '#src/types/chat.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useMessageStore } from '#src/stores/messageStore.ts';
  import ProfileName from './ProfileName.svelte';
  export let message: Message;
  export let ontoggle: ((emoji: string, remove: boolean) => Promise<void>) | undefined = undefined;
  export let readonly = false;
  let selected = '';
  $: reactions = message.meta.reactions ?? [];
  $: groups = [...new Set(reactions.map((reaction) => reaction.emoji))];
  const nostr = useNostrStore();
  const messages = useMessageStore();
  let error = '';
  async function toggle(emoji: string) {
    try {
      const mine = reactions.find(
        (reaction) =>
          reaction.emoji === emoji && reaction.reactorPublicKey === nostr.getLoggedInPublicKeyHex(),
      );
      if (ontoggle) await ontoggle(emoji, Boolean(mine));
      else if (mine) await messages.removeReaction(message.chatId, message.id, mine);
      else await messages.addReaction(message.chatId, message.id, emoji);
      selected = '';
    } catch {
      error = 'Could not update reaction. Please retry.';
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') selected = '';
  }}
  onclick={(event) => {
    if (!(event.target as HTMLElement).closest('.reactions')) selected = '';
  }}
/>
<div class="reactions">
  {#each groups as emoji}
    {@const authors = reactions.filter((reaction) => reaction.emoji === emoji)}
    <div class="reaction">
      <button
        aria-label={`${authors[0].name || emoji} reaction`}
        aria-expanded={selected === emoji}
        onclick={() => (selected = selected === emoji ? '' : emoji)}
        >{emoji}{authors.length > 1 ? ` ${authors.length}` : ''}</button
      >
      <div class="reaction-details" class:open={selected === emoji} role="tooltip">
        {#each authors as author}<div>
            <ProfileName
              publicKey={author.reactorPublicKey}
              fallback={author.reactorPublicKey.slice(0, 16)}
            /><small>{author.reactorPublicKey.slice(0, 16)}</small>
          </div>{/each}
        {#if selected === emoji && !readonly}<button onclick={() => toggle(emoji)}
            >{authors.some((a) => a.reactorPublicKey === nostr.getLoggedInPublicKeyHex())
              ? 'Remove reaction'
              : 'Add reaction'}</button
          >{/if}
      </div>
    </div>
  {/each}
  {#if error}<span role="alert">{error}</span>{/if}
</div>

<style>
  .reactions {
    display: flex;
    gap: 4px;
  }
  .reaction {
    position: relative;
  }
  button {
    border-radius: 8px;
    padding: 3px 8px;
    background: var(--nc-hover);
  }
  .reaction-details {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    z-index: 20;
    min-width: 190px;
    max-width: 260px;
    padding: 10px;
    background: var(--nc-menu-bg);
    color: var(--nc-text);
    border: 1px solid var(--nc-border);
    border-radius: 8px;
    box-shadow: var(--nc-shadow-md);
  }
  .reaction:hover .reaction-details,
  .reaction:focus-within .reaction-details,
  .reaction-details.open {
    display: block;
  }
  small {
    display: block;
    color: var(--nc-text-secondary);
  }
</style>
