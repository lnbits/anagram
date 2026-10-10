<script lang="ts">
  import RelayInfo from './RelayInfo.svelte';
  export let value: unknown;
  export let label = '';
  export let depth = 0;
  $: title = label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
  $: primitive = value === null || typeof value !== 'object';
  $: nips = label === 'supported_nips' && Array.isArray(value);
  $: entries = value && typeof value === 'object' ? Object.entries(value).slice(0, 100) : [];
</script>

<div class="relay-info-fields">
  {#if primitive || nips || depth >= 5}<label
      >{title}<input
        readonly
        disabled
        value={nips
          ? (value as unknown[]).join(', ')
          : primitive
            ? String(value ?? 'null')
            : JSON.stringify(value)}
      /></label
    >
  {:else}{#if label}<strong>{title}</strong>{/if}{#each entries as [key, entry]}<RelayInfo
        value={entry}
        label={key}
        depth={depth + 1}
      />{/each}{/if}
</div>

<style>
  .relay-info-fields {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .relay-info-fields :global(.relay-info-fields .relay-info-fields) {
    padding-inline-start: 12px;
  }
</style>
