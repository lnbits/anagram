<script lang="ts">
  import type { Snippet } from 'svelte';
  import { portal } from '#src/lib/actions/portal.ts';
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import Icon from './Icon.svelte';
  export let title: string;
  export let label: string = title;
  export let closeLabel = 'Close dialog';
  export let busy = false;
  export let persistent = false;
  export let onclose: () => void;
  // Called as soon as Escape dismisses the dialog, before it is gone, for work that must
  // stop at once. The dialog then closes as usual and onclose follows.
  export let ondismiss: (() => void) | undefined = undefined;
  export let children: Snippet;
  // Escape closes the native dialog, but its close event can arrive much later, while the
  // owner still treats the dialog as open. Report that close once, whichever comes first.
  let reported = false;
  function closed() {
    if (reported) return;
    reported = true;
    onclose();
  }
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
    if (!busy && !persistent) onclose();
  }}
  oncancel={(event) => {
    if (busy || persistent) {
      event.preventDefault();
      return;
    }
    ondismiss?.();
    // After the native close has run (it restores focus), unless the owner already knows.
    const dialog = event.currentTarget;
    setTimeout(() => {
      if (!dialog.open && dialog.isConnected) closed();
    });
  }}
  onclose={(event) => {
    if (event.currentTarget.isConnected) closed();
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
