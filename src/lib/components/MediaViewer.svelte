<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { portal } from '#src/lib/actions/portal.ts';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  export let url: string;
  export let name = 'attachment';
  // Decrypted media: url is a local object URL, so there is no original to open and nothing to
  // fetch; the verified plaintext is saved directly.
  export let encrypted = false;
  let downloadError = '';
  async function download() {
    if (encrypted) {
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      return;
    }
    try {
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error();
      const blob = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blob;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(blob), 1000);
    } catch {
      downloadError = 'Download failed. Try opening the original image.';
    }
  }
  export let onclose: () => void;
  let scale = 1,
    x = 0,
    y = 0,
    dragging = false;
  let dialog: HTMLDivElement;
  let gesture: {
    pointerId: number;
    x: number;
    y: number;
    backdrop: boolean;
    moved: boolean;
  } | null = null;
  function finishGesture(event: PointerEvent) {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture = null;
    dragging = false;
    if (
      !current.backdrop ||
      current.moved ||
      Math.hypot(event.clientX - current.x, event.clientY - current.y) > 5
    )
      return;
    const image = dialog.querySelector('img')?.getBoundingClientRect();
    if (
      image &&
      (event.clientX < image.left ||
        event.clientX > image.right ||
        event.clientY < image.top ||
        event.clientY > image.bottom)
    )
      onclose();
  }
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.focus();
    return () => previous?.focus();
  });
  function reset() {
    scale = 1;
    x = 0;
    y = 0;
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose();
    if (event.key === '+') scale = Math.min(5, scale + 0.25);
    if (event.key === '-') scale = Math.max(1, scale - 0.25);
    if (event.key === 'Tab') {
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
      const first = buttons[0],
        last = buttons.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  use:portal
  class="image-viewer"
  role="dialog"
  aria-modal="true"
  aria-label="Image attachment"
  tabindex="-1"
  bind:this={dialog}
  onkeydown={keyboard}
  onclick={(event) => {
    if (event.target === event.currentTarget || event.target === dialog.querySelector('header'))
      onclose();
  }}
>
  <header>
    <button
      class="icon-button"
      aria-label="Zoom out"
      onclick={() => (scale = Math.max(1, scale - 0.25))}>−</button
    ><button
      class="icon-button"
      aria-label="Zoom in"
      onclick={() => (scale = Math.min(5, scale + 0.25))}>+</button
    ><button onclick={reset}>Reset zoom</button>{#if !encrypted}<button
        onclick={() => openExternalHttpUrl(url)}>Open original</button
      >{/if}<button onclick={download}>Download image</button><button
      class="icon-button"
      aria-label="Close image"
      onclick={onclose}><Icon name="close" /></button
    >
  </header>
  {#if downloadError}<p role="alert">{downloadError}</p>{/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="image-canvas"
    onwheel={(e) => {
      e.preventDefault();
      scale = Math.max(1, Math.min(5, scale + (e.deltaY < 0 ? 0.15 : -0.15)));
    }}
    onpointerdown={(e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      gesture = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        backdrop: e.target === e.currentTarget,
        moved: false,
      };
      dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onpointerup={finishGesture}
    onpointercancel={() => {
      gesture = null;
      dragging = false;
    }}
    onlostpointercapture={() => {
      gesture = null;
      dragging = false;
    }}
    onpointermove={(e) => {
      if (
        gesture &&
        e.pointerId === gesture.pointerId &&
        Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 5
      )
        gesture.moved = true;
      if (dragging && gesture?.pointerId === e.pointerId && scale > 1) {
        x += e.movementX;
        y += e.movementY;
      }
    }}
  >
    <img
      src={url}
      alt="Attachment"
      draggable="false"
      referrerpolicy="no-referrer"
      style:transform={`translate(${x}px,${y}px) scale(${scale})`}
    />
  </div>
</div>

<style>
  .image-viewer {
    position: fixed;
    inset: 0;
    background: #080d14f5;
    z-index: 100;
    display: flex;
    flex-direction: column;
    color: white;
  }
  header {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    padding: 12px;
  }
  header .icon-button {
    color: white;
  }
  .image-canvas {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: grid;
    place-items: center;
    touch-action: none;
  }
  img {
    position: absolute;
    inset: 0;
    margin: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    user-select: none;
  }
</style>
