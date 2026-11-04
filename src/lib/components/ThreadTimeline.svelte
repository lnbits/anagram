<script lang="ts">
  import { onDestroy, tick, type Snippet } from 'svelte';
  import { threadPosition } from '#src/lib/actions/threadPosition.ts';
  import { threadHistoryPull } from '#src/lib/actions/threadHistoryPull.ts';
  import { threadNewerScroll } from '#src/lib/actions/threadNewerScroll.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  export let element: HTMLDivElement;
  export let chatId: string;
  export let publicKey: string = chatId;
  export let label = 'Messages';
  export let firstDay = '';
  export let hasOlder = false;
  export let historyStatus = '';
  export let hasNewer = false;
  export let loading = false;
  export let nearBottom = true;
  export let onolder: () => void;
  export let onnewer: () => Promise<void>;
  export let onlatest: () => void;
  export let onscroll: () => void = () => {};
  export let onmount: (node: HTMLDivElement) => void = () => {};
  export let children: Snippet;
  // Floating controls (e.g. jump to reactions) anchored to the thread's bottom edge.
  export let overlay: Snippet | undefined = undefined;
  let stickyDay = '';
  let frame = 0;
  let dayTimer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let loadingNewer = false;
  async function newer() {
    loadingNewer = true;
    try {
      await onnewer();
      await tick();
    } finally {
      loadingNewer = false;
    }
  }
  function updateDay() {
    if (!element) return;
    const top = element.getBoundingClientRect().top + 38;
    const rows = element.querySelectorAll<HTMLElement>('.message-row');
    // Rows are vertically ordered, as in threadPosition. Avoid measuring the
    // entire cached window while scrolling near its bottom.
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].getBoundingClientRect().bottom > top) high = middle;
      else low = middle + 1;
    }
    stickyDay = rows[Math.min(low, rows.length - 1)]?.dataset.dayLabel ?? '';
  }
  function scrolled() {
    onscroll();
    // Positioning stays immediate in threadPosition; the decorative date can lag slightly.
    if (dayTimer === undefined && !frame)
      dayTimer = setTimeout(() => {
        dayTimer = undefined;
        frame = requestAnimationFrame(() => {
          frame = 0;
          updateDay();
        });
      }, 100);
  }
  function mount(node: HTMLDivElement) {
    onmount(node);
  }
  $: if (firstDay || chatId)
    void tick().then(() => {
      if (active) updateDay();
    });
  onDestroy(() => {
    active = false;
    clearTimeout(dayTimer);
    cancelAnimationFrame(frame);
  });
</script>

<!-- Floating buttons are positioned against the thread viewport, so they always sit
     just above whatever follows it (reply/edit bar, request banner, growing composer). -->
<div class="thread-viewport">
<!-- Preserve native keyboard scrolling in the focusable message log. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="messages"
  class:loading-history={loading}
  bind:this={element}
  use:threadPosition={{ chatId, hasNewer, onchange: (value) => (nearBottom = value) }}
  use:mount
  use:threadHistoryPull={{
    chatId,
    canLoad: () => hasOlder && !loading && !loadingNewer,
    loading: () => loading || loadingNewer,
    load: onolder,
  }}
  use:threadNewerScroll={{
    chatId,
    canLoad: () => hasNewer && !loading && !loadingNewer,
    load: newer,
  }}
  tabindex="-1"
  role="log"
  aria-label={label}
  data-testid="chat-thread"
  data-chat-public-key={publicKey}
  onscroll={scrolled}
>
  {#if firstDay}<div class="thread-day-sticky" aria-hidden="true">
      <span>{stickyDay || firstDay}</span>
    </div>{/if}
  {#if hasOlder || (loading && !loadingNewer)}<div class="thread-more thread-more--top">
      <button
        class="thread-more__button"
        data-testid="thread-load-older"
        aria-label="Load earlier messages"
        aria-busy={loading && !loadingNewer}
        title={historyStatus || undefined}
        disabled={loading || loadingNewer}
        onmousedown={(event) => event.preventDefault()}
        onclick={onolder}
        >{#if loading && !loadingNewer}<span class="thread-history-spinner" aria-hidden="true"
          ></span>{:else}<Icon name="up" />{/if}{$translate('common.more')}</button
      >
    </div>{/if}
  {#if historyStatus}<span class="thread-history-status" role="status">{historyStatus}</span>{/if}
  {@render children()}
  {#if loadingNewer}<div
      class="thread-more thread-more--bottom"
      role="status"
      aria-label="Loading newer messages"
    >
      <span class="thread-history-spinner" aria-hidden="true"></span>
    </div>{/if}
</div>
{#if !nearBottom}<button class="jump-latest" aria-label="Jump to latest messages" onclick={onlatest}
    ><Icon name="down" /></button
  >{/if}
{@render overlay?.()}
</div>
