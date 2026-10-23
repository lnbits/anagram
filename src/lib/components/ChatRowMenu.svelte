<script lang="ts">
  import { dismissOnOutside } from '#src/lib/actions/dismissOnOutside.ts';
  import Icon from './Icon.svelte';
  export let items: { action: string; label: string; danger?: boolean }[];
  export let onaction: (action: string) => void;
  export let testId = 'chat-item-actions-button';
  let open = false;
  let trigger: HTMLButtonElement;
</script>

<button
  bind:this={trigger}
  class="icon-button row-menu"
  aria-label="Chat actions"
  data-testid={testId}
  aria-expanded={open}
  onclick={() => (open = !open)}><Icon name="more" /></button
>
{#if open}<div
    class="row-dropdown"
    role="menu"
    tabindex="-1"
    use:dismissOnOutside={{ dismiss: () => (open = false), trigger }}
  >
    {#each items as item (item.action)}<button
        role="menuitem"
        class:danger-text={item.danger}
        onclick={() => {
          open = false;
          onaction(item.action);
        }}>{item.label}</button
      >{/each}
  </div>{/if}

<style>
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
