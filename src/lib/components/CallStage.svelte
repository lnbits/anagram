<script lang="ts">
  import { onDestroy } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import CallVideo from './CallVideo.svelte';
  export let active = false;
  export let maxFill = false;
  export let screens: Array<{
    id: string;
    name: string;
    url?: string;
    stream?: MediaStream | null;
  }> = [];
  export let onblocked: () => void = () => {};
  let stage: HTMLElement;
  let windowOpen = false;
  let popup: Window | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let observer: MutationObserver | undefined;
  let stopFrames: Array<() => void> = [];
  export function focusWindow() {
    popup?.focus();
  }
  function restore() {
    observer?.disconnect();
    observer = undefined;
    stopFrames.forEach((stop) => stop());
    stopFrames = [];
    windowOpen = false;
    popup = null;
    clearInterval(poll);
  }
  // Keep the live MediaSource elements attached to their original document. Moving
  // them to another window detaches their SourceBuffers and can end the call.
  // Mirror decoded frames instead: no second decoder, transport, or audio player.
  function mirror(source: Node, targetDocument: Document): Node {
    if (source instanceof HTMLVideoElement) {
      const canvas = targetDocument.createElement('canvas');
      for (const attribute of source.attributes) {
        if (attribute.name !== 'src') canvas.setAttribute(attribute.name, attribute.value);
      }
      canvas.setAttribute('role', 'img');
      canvas.setAttribute(
        'aria-label',
        source.getAttribute('aria-label') || $translate('call.presentationWindow'),
      );
      canvas.style.cssText = 'display:block;min-height:0;object-fit:contain';
      const context = canvas.getContext('2d');
      let frame = 0;
      let stopped = false;
      const draw = () => {
        if (stopped) return;
        if (source.readyState >= 2 && source.videoWidth && context) {
          if (canvas.width !== source.videoWidth) canvas.width = source.videoWidth;
          if (canvas.height !== source.videoHeight) canvas.height = source.videoHeight;
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
        }
        if (source.requestVideoFrameCallback) frame = source.requestVideoFrameCallback(draw);
      };
      draw();
      const fallback = source.requestVideoFrameCallback ? undefined : setInterval(draw, 40);
      stopFrames.push(() => {
        stopped = true;
        if (frame) source.cancelVideoFrameCallback(frame);
        clearInterval(fallback);
      });
      return canvas;
    }
    const copy = targetDocument.importNode(source, false);
    for (const child of source.childNodes) copy.appendChild(mirror(child, targetDocument));
    return copy;
  }
  export function openWindow() {
    if (popup && !popup.closed) {
      popup.focus();
      return;
    }
    const next = window.open('about:blank', 'anagram-call-stage', 'popup,width=1100,height=750');
    if (!next) {
      onblocked();
      return;
    }
    popup = next;
    next.document.body.className = document.body.className;
    next.document.title = $translate('call.presentationWindow');
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]'))
      next.document.head.appendChild(node.cloneNode(true));
    const style = next.document.createElement('style');
    style.textContent =
      'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:white;font-family:system-ui}body{box-sizing:border-box;padding:8px;display:flex;flex-direction:column}main{flex:1;min-height:0;display:flex}';
    next.document.head.appendChild(style);
    const target = next.document.createElement('main');
    next.document.body.appendChild(target);
    const refresh = () => {
      stopFrames.forEach((stop) => stop());
      stopFrames = [];
      if (stage && !next.closed) target.replaceChildren(mirror(stage, next.document));
    };
    refresh();
    observer = new MutationObserver(refresh);
    if (stage)
      observer.observe(stage, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    windowOpen = true;
    next.addEventListener('pagehide', restore, { once: true });
    poll = setInterval(() => {
      if (next.closed) restore();
    }, 500);
  }
  function closeWindow() {
    const previous = popup;
    restore();
    previous?.close();
  }

  $: if (!active) closeWindow();
  onDestroy(closeWindow);
</script>

{#if windowOpen}<div class="call-stage-toolbar">
    <button onclick={focusWindow}>{$translate('call.presentationWindow')}</button><button
      data-testid="call-return-presentation"
      onclick={closeWindow}>{$translate('call.returnPresentation')}</button
    >
  </div>{/if}
<section
  bind:this={stage}
  class="call-stage"
  class:call-stage--sharing={screens.length > 0}
  class:call-stage--fill={maxFill}
  data-testid="call-stage"
>
  {#if screens.length}<div
      class="call-stage__screens"
      style={`--screen-columns:${Math.ceil(Math.sqrt(screens.length))};--screen-rows:${Math.ceil(screens.length / Math.ceil(Math.sqrt(screens.length)))}`}
    >
      {#each screens as screen (screen.id)}<figure class="call-stage__screen">
          <CallVideo
            url={screen.url ?? ''}
            stream={screen.stream ?? null}
            testid="call-screen-media"
            label={screen.name}
          />{#if screen.name}<figcaption>{screen.name}</figcaption>{/if}
        </figure>{/each}
    </div>{/if}
  <div class="call-stage__cameras"><slot /></div>
</section>

<style>
  .call-stage-toolbar {
    flex-shrink: 0;
  }
  .call-stage {
    background: var(--call-stage-background, #000);
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: 8px;
    overflow: hidden;
  }
  .call-stage--sharing {
    grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
  }
  .call-stage__screens {
    min-height: 0;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: 8px;
  }
  .call-stage__screen {
    position: relative;
    display: flex;
    flex-direction: column;
    margin: 0;
    min-height: 0;
    min-width: 0;
    background: transparent;
    border-radius: 0;
    overflow: hidden;
  }
  .call-stage__screen :global(video),
  .call-stage__screen :global(canvas) {
    flex: 1;
    min-height: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .call-stage__screen figcaption {
    position: absolute;
    bottom: 6px;
    left: 6px;
    max-width: calc(100% - 12px);
    padding: 4px 8px;
    border-radius: 4px;
    color: white;
    background: rgba(0, 0, 0, 0.65);
    pointer-events: none;
    font-size: 0.85rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .call-stage__cameras {
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  @media (max-width: 599px) {
    .call-stage--sharing {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 2fr) minmax(0, 1fr);
    }
  }
  .call-stage--fill {
    gap: 0;
  }
  .call-stage--fill :global(.call-panel__media) {
    border-radius: 0;
  }
  .call-stage--fill :global(.call-panel__local:only-child) {
    position: static;
    width: 100%;
    height: 100%;
    max-height: none;
  }
  .call-stage--fill .call-stage__cameras :global(video),
  .call-stage--fill .call-stage__cameras :global(canvas) {
    object-fit: cover !important;
  }
  .call-stage--fill .call-stage__screens {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
  }
  .call-stage--fill .call-stage__screen {
    flex: 1 1 calc(100% / var(--screen-columns));
    height: calc(100% / var(--screen-rows));
  }
  .call-stage--fill.call-stage--sharing:has(.call-stage__cameras:empty) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .call-stage--fill .call-stage__cameras:empty {
    display: none;
  }
</style>
