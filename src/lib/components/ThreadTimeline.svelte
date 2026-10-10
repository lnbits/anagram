<script lang="ts">
  import { onDestroy, tick, type Snippet } from 'svelte';
  import { threadHistoryPull } from '#src/lib/actions/threadHistoryPull.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  export let element: HTMLDivElement;
  export let chatId: string;
  export let publicKey: string = chatId;
  export let label = 'Messages';
  export let firstDay = '';
  export let hasOlder = false;
  export let hasNewer = false;
  export let loading = false;
  export let nearBottom = true;
  export let onolder: () => void;
  export let onnewer: () => void;
  export let onlatest: () => void;
  export let onscroll: () => void = () => {};
  export let onmount: (node: HTMLDivElement) => void = () => {};
  export let children: Snippet;
  let stickyDay = '';
  let previousTop = 0;
  let touchY: number | null = null;
  let frame = 0;
  let active = true;
  function updateDay() {
    if (!element) return;
    const top = element.getBoundingClientRect().top + 38;
    const rows = [...element.querySelectorAll<HTMLElement>('.message-row')];
    stickyDay =
      rows.find((row) => row.getBoundingClientRect().bottom > top)?.dataset.dayLabel ??
      rows.at(-1)?.dataset.dayLabel ??
      '';
  }
  function releaseBottom() {
    // A short thread has nowhere to scroll up to; keep following new messages.
    if (element.scrollTop > 0) nearBottom = false;
  }
  function scrolled() {
    const top = Math.max(0, element.scrollTop);
    if (!loading) {
      // Upward movement releases immediately. Only scrolling back to the actual
      // bottom resumes following; resize notifications alone must not reattach.
      if (top < previousTop) nearBottom = false;
      else if (top > previousTop)
        nearBottom = element.scrollHeight - top - element.clientHeight <= 1;
    }
    previousTop = top;
    onscroll();
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateDay();
      });
  }
  function mount(node: HTMLDivElement) {
    previousTop = Math.max(0, node.scrollTop);
    onmount(node);
    const observer = new ResizeObserver(scrolled);
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
  $: if (firstDay || chatId)
    void tick().then(() => {
      if (active) updateDay();
    });
  onDestroy(() => {
    active = false;
    cancelAnimationFrame(frame);
  });
</script>

<!-- Preserve native keyboard scrolling in the focusable message log. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="messages"
  class:loading-history={loading}
  bind:this={element}
  use:mount
  use:threadHistoryPull={{
    chatId,
    canLoad: () => hasOlder && !loading,
    loading: () => loading,
    load: onolder,
  }}
  tabindex="-1"
  role="log"
  aria-label={label}
  data-testid="chat-thread"
  data-chat-public-key={publicKey}
  onscroll={scrolled}
  onwheel={(event) => {
    if (!event.ctrlKey && event.deltaY < 0) releaseBottom();
  }}
  ontouchstart={(event) => {
    touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
  }}
  ontouchmove={(event) => {
    const y = event.touches.length === 1 ? event.touches[0].clientY : null;
    if (y !== null && touchY !== null && y > touchY) releaseBottom();
    touchY = y;
  }}
  ontouchend={() => (touchY = null)}
  ontouchcancel={() => (touchY = null)}
  onkeydown={(event) => {
    if (
      event.target === element &&
      (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))
    )
      releaseBottom();
  }}
>
  {#if firstDay}<div class="thread-day-sticky" aria-hidden="true">
      <span>{stickyDay || firstDay}</span>
    </div>{/if}
  {#if hasOlder}<div class="thread-more thread-more--top">
      <button
        class="thread-more__button"
        data-testid="thread-load-older"
        aria-label="Load earlier messages"
        aria-busy={loading}
        disabled={loading}
        onmousedown={(event) => event.preventDefault()}
        onclick={onolder}><Icon name="up" />{$translate('common.more')}</button
      >
    </div>{/if}
  {@render children()}
  {#if hasNewer}<button class="load-older" onclick={onnewer}>Load newer messages</button>{/if}
</div>
{#if !nearBottom}<button class="jump-latest" aria-label="Jump to latest messages" onclick={onlatest}
    ><Icon name="down" /></button
  >{/if}
