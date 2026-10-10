<script lang="ts">
  import { diagnosticJson } from '#src/utils/diagnosticExport.ts';
  export let value: unknown;
  // Keep the same export redaction as the previous JSON view.
  $: safe = JSON.parse(diagnosticJson(value ?? null));
  $: fields = safe && typeof safe === 'object' && !Array.isArray(safe) ? Object.entries(safe) : [];
  function label(key: string) {
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  }
</script>

{#if fields.length}
  <dl class="developer-facts diagnostic-fields">
    {#each fields as [key, entry]}
      <dt>{label(key)}</dt>
      <dd>
        {#if entry !== null && typeof entry === 'object'}
          <details>
            <summary
              >{Array.isArray(entry)
                ? `${entry.length} items`
                : `${Object.keys(entry).length} fields`}</summary
            >
            <pre>{JSON.stringify(entry, null, 2)}</pre>
          </details>
        {:else}{entry === null ? '—' : String(entry)}{/if}
      </dd>
    {/each}
  </dl>
{:else}<pre>{JSON.stringify(safe, null, 2)}</pre>{/if}
