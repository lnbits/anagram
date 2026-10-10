<script lang="ts">
  import { formatMessage } from '#src/utils/messageFormatting.ts';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  import FormattedMessage from './FormattedMessage.svelte';

  // The bundled specs use only headings, paragraphs, lists and inline formatting.
  // Render Svelte text nodes rather than interpreting Markdown as HTML.
  export let markdown: string;
  $: blocks = markdown.trim().split(/\n\s*\n/);
  let linkError = '';
  async function openLink(href: string) {
    try {
      await openExternalHttpUrl(href);
    } catch {
      linkError = 'Could not open this link.';
    }
  }
</script>

{#snippet inline(text: string)}
  <FormattedMessage
    parts={formatMessage(text)}
    onopen={openLink}
    oncontact={() => {}}
    onlinkmenu={() => {}}
  />
{/snippet}

<div class="markdown">
  {#each blocks as block}
    {@const heading = /^(#{1,3}) (.+)$/.exec(block)}
    {#if heading}
      <svelte:element this={`h${heading[1].length}`}>
        {@render inline(heading[2])}
      </svelte:element>
    {:else if block.startsWith('- ')}
      <ul>
        {#each block.split(/\n(?=- )/) as item}
          <li>{@render inline(item.slice(2).replace(/\n/g, ' '))}</li>
        {/each}
      </ul>
    {:else}
      <p>{@render inline(block.replace(/\n/g, ' '))}</p>
    {/if}
  {/each}
  {#if linkError}<p role="alert">{linkError}</p>{/if}
</div>

<style>
  .markdown {
    color: var(--nc-text);
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3) {
    font-size: 16px;
    line-height: 1.4;
    margin: 20px 0 8px;
  }
  p,
  ul {
    margin: 12px 0;
  }
  ul {
    padding-left: 22px;
    list-style: disc;
  }
  li + li {
    margin-top: 8px;
  }
</style>
