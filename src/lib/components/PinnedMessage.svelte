<script lang="ts">
  import Icon from './Icon.svelte';
  export let text: string;
  export let onopen: () => void;
  export let onunpin: (() => void) | undefined = undefined;
  export let busy = false;
</script>

<div class="pinned-message" data-testid="pinned-message">
  <button
    class="pinned-message__preview"
    aria-label="Go to pinned message"
    onclick={onopen}
    disabled={busy}
  >
    <span class="pinned-message__label">Pinned message</span>
    <span class="pinned-message__text">{text || 'Message unavailable'}</span>
  </button>
  {#if onunpin}
    <button class="icon-button" aria-label="Unpin message" onclick={onunpin} disabled={busy}
      ><Icon name="close" /></button
    >
  {/if}
</div>

<style>
  .pinned-message {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 8px;
    padding: 7px 16px;
    border-bottom: 1px solid var(--nc-border);
    background: color-mix(in srgb, var(--q-primary) 7%, var(--nc-panel-header-bg));
    color: var(--nc-text);
  }
  .pinned-message__preview {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
    border-left: 2px solid var(--q-primary);
    padding: 0 8px;
    text-align: left;
    font-size: 13px;
    line-height: 1.4;
  }
  .pinned-message__label {
    color: var(--q-primary);
    font-weight: 600;
  }
  .pinned-message__text {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button:focus-visible {
    outline: 2px solid var(--q-primary);
    outline-offset: 2px;
  }
</style>
