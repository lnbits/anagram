<script lang="ts">
  import type { Snippet } from 'svelte';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  export let name: string;
  export let subtitle: string;
  export let picture = '';
  export let publicKey = '';
  export let privateGroup = false;
  export let publicGroup = false;
  export let label: string | undefined = undefined;
  export let onopen: () => void;
  export let oncopy: (() => void) | undefined = undefined;
  export let onback: () => void;
  export let actions: Snippet | undefined = undefined;
</script>

<header class="thread-header">
  <button class="icon-button mobile-back" aria-label="Back to chats" onclick={onback}
    ><Icon name="back" /></button
  >
  <Avatar {name} {picture} {publicKey} {privateGroup} {publicGroup} eager />
  <div class="thread-identity">
    <div class="thread-title">
      <button class="identity-open" aria-label={label ?? `${name} ${subtitle}`} onclick={onopen}
        ><strong>{name}</strong></button
      >
      {#if oncopy}<button
          class="copy-npub"
          aria-label="Copy npub"
          title="Copy npub"
          onclick={oncopy}><Icon name="content_copy" /></button
        >{/if}
    </div>
    <small>{subtitle}</small>
  </div>
  <div class="header-actions">{@render actions?.()}</div>
</header>

<style>
  .thread-title {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .identity-open {
    min-width: 0;
    padding: 0;
    text-align: left;
  }
  .identity-open strong {
    display: block;
  }
  .copy-npub {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 4px;
    color: var(--nc-text-secondary);
  }
  .copy-npub :global(svg) {
    width: 14px;
    height: 14px;
  }
  .copy-npub:hover {
    color: var(--q-primary);
  }
  .copy-npub:focus-visible {
    outline: 2px solid var(--q-primary);
    outline-offset: 2px;
  }
</style>
