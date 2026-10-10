<script lang="ts">
  import { onDestroy } from 'svelte';
  import { translate } from '#src/i18n.ts';
  export let enabled = false;
  let autoHide = false,
    revealed = false,
    hovered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function reset(enabledState: boolean) {
    // Reset on a phase transition, regardless of its direction.
    void enabledState;
    autoHide = false;
    revealed = false;
    cancelHide();
  }
  $: reset(enabled);
  $: hidden = autoHide && !revealed;
  function cancelHide() {
    clearTimeout(timer);
  }
  function reveal() {
    cancelHide();
    revealed = true;
  }
  function enter() {
    hovered = true;
    cancelHide();
  }
  function scheduleHide() {
    cancelHide();
    timer = setTimeout(() => {
      const focused = document.activeElement;
      const keyboardFocus =
        focused?.matches(':focus-visible') &&
        focused.closest('.call-controls-tray, .call-controls-edge');
      if (!hovered && !keyboardFocus && !document.querySelector('[data-call-device-menu]'))
        revealed = false;
      else if (!hovered) scheduleHide();
    }, 400);
  }
  function leave() {
    hovered = false;
    scheduleHide();
  }
  function toggle() {
    cancelHide();
    autoHide = !autoHide;
    revealed = false;
    if (autoHide && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  onDestroy(cancelHide);
</script>

<div
  role="group"
  aria-label="Call controls"
  class="call-controls-tray"
  class:call-controls-tray--hidden={hidden}
  data-testid="call-controls-tray"
  onpointerenter={enter}
  onpointerleave={leave}
  onfocusin={cancelHide}
  onfocusout={scheduleHide}
>
  <div class="call-controls-tray__clip" inert={hidden}><slot {autoHide} {toggle} /></div>
</div>
{#if autoHide}<button
    class="call-controls-edge"
    aria-label={$translate('call.showControls')}
    data-testid="call-controls-edge"
    onpointerenter={reveal}
    onpointerleave={scheduleHide}
    onfocus={reveal}
    onclick={reveal}><span aria-hidden="true">⌃</span></button
  >{/if}

<style>
  .call-controls-tray {
    display: grid;
    grid-template-rows: 1fr;
    min-height: 0;
    flex-shrink: 0;
    transition: grid-template-rows 220ms ease;
  }
  .call-controls-tray__clip {
    min-height: 0;
    overflow: visible;
    transform: translateY(0);
    transition:
      transform 220ms ease,
      opacity 220ms ease;
  }
  .call-controls-tray--hidden {
    grid-template-rows: 0fr;
  }
  .call-controls-tray--hidden .call-controls-tray__clip {
    overflow: hidden;
    transform: translateY(100%);
    opacity: 0;
    pointer-events: none;
  }
  .call-controls-edge {
    position: fixed;
    z-index: 1;
    bottom: 0;
    left: 0;
    width: 100%;
    height: max(16px, env(safe-area-inset-bottom));
    padding: 0;
    border: 0;
    background: transparent;
    color: white;
    cursor: pointer;
  }
  .call-controls-edge span {
    opacity: 0;
  }
  .call-controls-edge:focus-visible {
    outline: 2px solid var(--q-primary);
    background: #101418;
  }
  .call-controls-edge:focus-visible span {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .call-controls-tray,
    .call-controls-tray__clip {
      transition: none;
    }
  }
</style>
