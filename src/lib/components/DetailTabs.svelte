<script lang="ts">
  export let items: string[];
  export let active: string;
  export let label: string;
  export let disabled = false;
  export let onselect: (value: string) => void;
</script>

<div class="tabs" role="tablist" aria-label={label}>
  {#each items as item}<button
      role="tab"
      aria-selected={active === item}
      {disabled}
      onclick={() => onselect(item)}>{item}</button
    >{/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    overflow: auto;
    margin: 16px 0;
    border-bottom: 1px solid var(--nc-border);
  }
  button {
    flex: 1;
    padding: 10px 4px;
  }
  button[aria-selected='true'] {
    color: var(--q-primary);
    border-bottom: 2px solid var(--q-primary);
  }
</style>
