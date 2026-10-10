<script lang="ts">
  import type { FormattedMessagePart } from '#src/utils/messageFormatting.ts';
  import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
  import { parseRoomLink } from '#src/utils/callRoom.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  import ProfileName from './ProfileName.svelte';
  import FormattedMessage from './FormattedMessage.svelte';
  export let parts: FormattedMessagePart[];
  export let onopen: (href: string) => void;
  export let oncontact: (pubkey: string) => void;
  export let onlinkmenu: (event: MouseEvent, href: string) => void;
  let revealed = new Set<string>();
  let previous: FormattedMessagePart[];
  $: if (parts !== previous) {
    previous = parts;
    revealed = new Set();
  }
  const tags = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', spoiler: 'span' };
</script>

{#each parts as part (part.key)}
  {#if part.type === 'format'}
    {#if part.format === 'spoiler' && !revealed.has(part.key)}<button
        type="button"
        class="spoiler"
        aria-label="Reveal spoiler"
        aria-expanded="false"
        onclick={() => {
          revealed = new Set([...revealed, part.key]);
        }}>••••••</button
      >
    {:else}<svelte:element
        this={tags[part.format]}
        class:revealed-spoiler={part.format === 'spoiler'}
        ><FormattedMessage
          parts={part.children}
          {onopen}
          {oncontact}
          {onlinkmenu}
        /></svelte:element
      >{/if}
  {:else if part.type === 'code'}<code class:block={part.block}>{part.text}</code>
  {:else if part.type === 'url'}
    {@const room = Boolean(parseRoomLink(part.href))}
    {@const publicGroup = publicGroupLinkTarget(part.href)}
    <a
      data-testid="message-url-link"
      class:room-link={room || publicGroup !== null}
      href={part.href}
      title={part.href}
      rel="noopener noreferrer"
      target="_blank"
      oncontextmenu={(event) => onlinkmenu(event, part.href)}
      onclick={(event) => {
        event.preventDefault();
        onopen(part.href);
      }}
      >{#if room || publicGroup}{$translate(room ? 'room.joinGroupCall' : 'Join chat')}<Icon
          name="group"
        />{:else}{part.text}{/if}</a
    >
  {:else if part.type === 'mention' && part.publicKey}<button
      class="mention"
      data-testid="message-mention-link"
      onclick={() => oncontact(part.publicKey!)}
    >
      @<ProfileName publicKey={part.publicKey} fallback={part.text.slice(1)} hydrate /></button
    >
  {:else}{part.text}{/if}
{/each}

<style>
  a,
  .mention {
    color: var(--q-primary);
  }
  .mention {
    padding: 0;
  }
  strong {
    font-weight: 700;
  }
  em {
    font-style: italic;
  }
  u {
    text-decoration: underline;
  }
  s {
    text-decoration: line-through;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.92em;
    padding: 1px 4px;
    border-radius: 4px;
    background: #0003;
  }
  code.block {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    white-space: pre;
    overflow-wrap: normal;
    padding: 10px 12px;
    margin: 6px 0;
    border-radius: 8px;
  }
  .spoiler {
    padding: 0 6px;
    font: inherit;
    color: var(--nc-text-secondary);
    background: var(--nc-search-bg);
    border-radius: 4px;
    cursor: pointer;
  }
  .revealed-spoiler {
    background: #ffffff0c;
  }
  .spoiler:focus-visible,
  .room-link:focus-visible {
    outline: 2px solid var(--q-primary);
    outline-offset: 2px;
  }
  .room-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--q-primary);
    border-radius: 10px;
    text-decoration: none;
    white-space: normal;
    vertical-align: middle;
    font-weight: 600;
  }
  .room-link:hover {
    background: color-mix(in srgb, var(--q-primary) 12%, transparent);
  }
</style>
