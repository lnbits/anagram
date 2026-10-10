<script lang="ts">
  import type { Snippet } from 'svelte';
  export let active = false;
  export let muted = false;
  export let chatId = '';
  export let publicKey = '';
  export let testId = 'chat-item';
  export let onselect: () => void;
  export let onkeydown: ((event: KeyboardEvent) => void) | undefined = undefined;
  export let children: Snippet;
  export let actions: Snippet | undefined = undefined;
</script>

<div class="chat-row" class:active class:muted>
  <button
    class="chat-item"
    onclick={onselect}
    {onkeydown}
    data-testid={testId}
    data-chat-id={chatId || undefined}
    data-chat-public-key={publicKey || undefined}
    aria-current={active ? 'page' : undefined}
  >
    {@render children()}
  </button>
  {@render actions?.()}
</div>

<style>
  .chat-row {
    position: relative;
    display: flex;
    align-items: center;
    min-height: 64px;
    padding-right: 36px;
  }
  .chat-item {
    min-height: 64px;
    padding: 0 14px;
    border: 0;
    gap: 8px;
    contain-intrinsic-size: auto 64px;
  }
  .chat-item:hover {
    background: transparent;
  }
  .chat-row:hover {
    background: var(--nc-hover);
  }
  .chat-row.active {
    background: var(--nc-active);
  }
  .chat-row.active > .chat-item {
    color: var(--nc-active-text);
  }
  .active > .chat-item :global(.private-group-badge) {
    color: var(--nc-active-group-icon, var(--q-primary));
  }
  .chat-row :global(.chat-copy strong) {
    font-size: 14px;
    font-weight: 600;
  }
  .chat-row :global(.chat-preview) {
    line-height: 1.25;
    margin-top: 4px;
  }
  .active > .chat-item :global(.chat-preview),
  .active > .chat-item :global(time),
  .active > .chat-item :global(.preview-author) {
    color: var(--nc-active-subtext);
  }
  @media (max-width: 767px) {
    .chat-row :global(.chat-copy strong) {
      font-size: var(--nc-mobile-ui-font-size);
    }
    .chat-row :global(.chat-preview) {
      font-size: var(--nc-mobile-caption-font-size);
    }
  }
</style>
