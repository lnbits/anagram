<script lang="ts">
  import type { Snippet } from 'svelte';
  import { portal } from '#src/lib/actions/portal.ts';
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import Icon from './Icon.svelte';
  export let title: string;
  export let label: string = title;
  export let closeLabel = 'Close dialog';
  export let busy = false;
  export let onclose: () => void;
  export let children: Snippet;
  function show(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
</script>

<dialog
  class="modal"
  aria-label={label}
  use:portal
  use:show
  use:dismissOnBackdrop={() => {
    if (!busy) onclose();
  }}
  oncancel={(event) => {
    if (busy) event.preventDefault();
  }}
  onclose={(event) => {
    if (event.currentTarget.isConnected) onclose();
  }}
>
  <header>
    <h2>{title}</h2>
    <button class="icon-button" aria-label={closeLabel} disabled={busy} onclick={onclose}
      ><Icon name="close" /></button
    >
  </header>
  {@render children()}
</dialog>

<style>
  dialog {
    margin: auto;
    max-width: calc(100vw - 24px);
    color: var(--nc-text);
  }
  dialog::backdrop {
    background: #0008;
  }
</style>
