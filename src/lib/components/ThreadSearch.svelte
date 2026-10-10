<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';

  export let onsearch: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ messageId: string; text: string }[]>;
  export let onselect: (id: string, signal: AbortSignal) => Promise<void>;
  export let onclose: () => void;
  export let onclear: () => void;
  export let hint = '';
  let query = '';
  let results: { messageId: string; text: string }[] = [];
  let index = -1;
  let busy = false;
  let error = '';
  let input: HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller = new AbortController();

  function cancel() {
    clearTimeout(timer);
    controller.abort();
    controller = new AbortController();
  }
  async function select(next: number) {
    if (!results.length) return;
    cancel();
    const { signal } = controller;
    index = (next + results.length) % results.length;
    error = '';
    onclear();
    try {
      await onselect(results[index].messageId, signal);
    } catch {
      if (!signal.aborted) error = 'Could not open this message. Try again.';
    }
  }
  function queueSearch() {
    cancel();
    onclear();
    results = [];
    index = -1;
    error = '';
    busy = Boolean(query.trim());
    if (!busy) return;
    const { signal } = controller;
    timer = setTimeout(async () => {
      try {
        const found = await onsearch(query, signal);
        if (signal.aborted) return;
        results = found;
        busy = false;
        if (results.length) await select(0);
      } catch {
        if (!signal.aborted) {
          busy = false;
          error = 'Could not search messages. Try again.';
        }
      }
    }, 120);
  }
  function close() {
    cancel();
    onclear();
    onclose();
  }
  onMount(() => {
    input.focus();
    return () => {
      cancel();
      onclear();
    };
  });
</script>

<div class="thread-search">
  <input
    bind:this={input}
    aria-label="Search messages"
    bind:value={query}
    oninput={queueSearch}
    onkeydown={(event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void select(index + (event.shiftKey ? -1 : 1));
      }
      if (event.key === 'Escape') close();
    }}
    placeholder="Search in this conversation"
  />
  <span data-testid="thread-search-status" role="status"
    >{busy
      ? 'Searching…'
      : results.length
        ? `${index + 1} / ${results.length}`
        : query.trim()
          ? 'No results'
          : ''}</span
  >
  <button
    class="icon-button"
    aria-label="Previous search result"
    disabled={!results.length}
    onclick={() => select(index + 1)}>↑</button
  >
  <button
    class="icon-button"
    aria-label="Next search result"
    disabled={!results.length}
    onclick={() => select(index - 1)}>↓</button
  >
  <button class="icon-button" aria-label="Close search" onclick={close}
    ><Icon name="close" /></button
  >
  <div class="search-results">
    {#if hint}<p>{hint}</p>{/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    {#each results.slice(0, 30) as result, i}<button onclick={() => select(i)}>{result.text}</button
      >{/each}
  </div>
</div>
