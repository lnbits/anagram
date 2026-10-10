<script lang="ts">
  import type { ContactRelay } from '#src/types/contact.ts';
  export let entries: ContactRelay[];
  export let url = '';
  export let editable = true;
  export let disabled = false;
  export let showFlags = false;
  export let maximum = Infinity;
  export let onadd: () => void;
  export let onremove: (index: number) => void;
  export let onflag: (index: number, flag: 'read' | 'write', value: boolean) => void = () => {};
</script>

<ul class="group-relays">
  {#each entries as entry, index}<li class="relay">
      <span>{entry.url}</span>
      {#if showFlags}{#each ['read', 'write'] as flag}<label
            ><input
              type="checkbox"
              checked={entry[flag as 'read' | 'write']}
              disabled={!editable || disabled}
              onchange={(event) =>
                onflag(index, flag as 'read' | 'write', event.currentTarget.checked)}
            />{flag === 'read' ? 'Read' : 'Write'}</label
          >{/each}{/if}
      {#if editable}<button
          class="outline"
          aria-label={`Remove relay ${entry.url}`}
          {disabled}
          onclick={() => onremove(index)}>Remove</button
        >{/if}
    </li>{:else}<li>No relays configured.</li>{/each}
</ul>
{#if editable}<label
    >Relay URL<input bind:value={url} placeholder="wss://relay.example.com" {disabled} /></label
  >
  <button
    class="outline"
    disabled={disabled || !url.trim() || entries.length >= maximum}
    onclick={onadd}>Add relay</button
  >{/if}

<style>
  ul {
    list-style: none;
    padding: 0;
  }
  .relay {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
  }
  span {
    width: 100%;
    overflow-wrap: anywhere;
  }
  .relay label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    margin: 0;
  }
  .relay input {
    width: auto;
  }
</style>
