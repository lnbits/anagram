<script lang="ts">
  import { onMount } from 'svelte';
  import type { EmojiGroup } from '#src/data/topEmojis.ts';
  export let onselect: (emoji: string) => void;
  let query = '';
  let groups: EmojiGroup[] = [];
  let filter: (typeof import('#src/data/topEmojis.ts'))['filterEmojiEntries'];
  let group: (typeof import('#src/data/topEmojis.ts'))['groupEmojiEntries'];
  onMount(() => {
    let active = true;
    void import('#src/data/topEmojis.ts').then((data) => {
      if (active) {
        filter = data.filterEmojiEntries;
        group = data.groupEmojiEntries;
        groups = data.EMOJI_GROUPS;
      }
    });
    return () => {
      active = false;
    };
  });
  $: if (filter && group) groups = group(filter(query));
</script>

<div class="picker">
  <input aria-label="Search emoji" placeholder="Search emoji" bind:value={query} />
  <div class="emoji-groups">
    {#each groups as category}<section>
        <h3>{category.label}</h3>
        <div class="emoji-grid">
          {#each category.emojis as item}<button
              type="button"
              title={item.label}
              aria-label={item.label}
              onclick={() => onselect(item.emoji)}>{item.emoji}</button
            >{/each}
        </div>
      </section>{/each}
  </div>
</div>

<style>
  .picker {
    width: min(360px, 90vw);
    padding: 10px;
    background: var(--nc-menu-bg);
    color: var(--nc-text);
    border: 1px solid var(--nc-border);
    border-radius: 12px;
    box-shadow: var(--nc-shadow-md);
  }
  .picker input {
    width: 100%;
    padding: 8px 12px;
  }
  .emoji-groups {
    max-height: 260px;
    overflow: auto;
  }
  section {
    content-visibility: auto;
    contain-intrinsic-size: auto 240px;
  }
  h3 {
    font-size: 12px;
    color: var(--nc-text-secondary);
    margin: 12px 0 4px;
  }
  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
  }
  .emoji-grid button {
    font-size: 24px;
    min-height: 42px;
    border-radius: 8px;
  }
  .emoji-grid button:hover {
    background: var(--nc-hover);
  }
</style>
