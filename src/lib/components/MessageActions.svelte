<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import type { Message } from '#src/types/chat.ts';
  import Icon from './Icon.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  export let message: Message;
  export let x: number;
  export let y: number;
  export let onaction: (action: string, message: Message) => void;
  export let onreact: (emoji: string, message: Message) => void = () => {};
  export let allowedActions: string[] = ['reply', 'copy', 'forward', 'edit', 'info', 'delete'];
  export let allowReactions = true;
  export let onclose: () => void;
  let menu: HTMLDivElement;
  let left = x,
    top = y,
    ready = false,
    picking = false;
  const actions = [
    ['reply', 'Reply', 'reply'],
    ['copy', 'Copy message', 'content_copy'],
    ['forward', 'Forward', 'forward'],
    ['edit', 'Edit', 'edit'],
    ['info', 'Nostr info', 'info'],
    ['pin', 'Pin message', 'pin'],
    ['unpin', 'Unpin message', 'pin'],
    ['delete', 'Delete', 'delete'],
  ];
  $: if (menu && x !== undefined && y !== undefined) position();
  function position() {
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8));
    ready = true;
  }
  async function moreEmoji() {
    picking = true;
    await tick();
    position();
    menu?.querySelector('input')?.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      onclose();
      return;
    }
    if (
      event.target instanceof HTMLInputElement ||
      !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
    )
      return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  onMount(() => {
    position();
    void tick().then(() => {
      if (menu?.isConnected) menu.querySelector('button')?.focus({ preventScroll: true });
    });
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    return () => observer.disconnect();
  });
</script>

<svelte:window onresize={position} />
<div
  bind:this={menu}
  class="message-context-menu"
  id="message-context-menu"
  data-testid="message-context-menu"
  role="menu"
  aria-label="Message actions"
  tabindex="-1"
  onkeydown={keydown}
  style:left={`${left}px`}
  style:top={`${top}px`}
  style:visibility={ready ? 'visible' : 'hidden'}
>
  {#if picking}<EmojiPicker onselect={(emoji) => onreact(emoji, message)} />
  {:else}
    <div class="action-list">
      {#each actions as [action, label, icon]}
        {#if allowedActions.includes(action) && (message.sender === 'me' || (action !== 'edit' && action !== 'delete'))}
          <button
            role="menuitem"
            aria-label={label}
            class:danger-text={action === 'delete'}
            onclick={() => onaction(action, message)}
            ><Icon name={icon} /><span
              >{$translate(
                action === 'info' ? 'common.nostrInfo' : action === 'copy' ? 'common.copy' : label,
              )}</span
            ></button
          >
        {/if}
      {/each}
    </div>
    {#if allowReactions}<div class="quick-reactions" aria-label="Quick reactions">
        {#each ['👍', '👎', '🙏', '❤️', '😂'] as emoji}<button
            aria-label={emoji === '👍' ? 'React' : `React ${emoji}`}
            onclick={() => onreact(emoji, message)}>{emoji}</button
          >{/each}
        <button aria-label="Choose reaction" onclick={moreEmoji}><Icon name="more" /></button>
      </div>{/if}
  {/if}
</div>

<style>
  .message-context-menu {
    position: fixed;
    z-index: 100;
    width: max-content;
    min-width: 224px;
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 16px);
    overflow: auto;
    border: 1px solid var(--nc-border);
    border-radius: 12px;
    background: var(--nc-menu-bg);
    color: var(--nc-text);
    box-shadow: var(--nc-shadow-md);
    padding: 6px;
  }
  .action-list {
    display: grid;
  }
  .action-list button {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 10px 12px;
    border-radius: 6px;
    text-align: left;
    font-size: 14px;
  }
  button:hover,
  button:focus-visible {
    background: var(--nc-hover);
    outline: none;
  }
  .quick-reactions {
    display: flex;
    justify-content: space-between;
    gap: 2px;
    padding-top: 6px;
    margin-top: 5px;
    border-top: 1px solid var(--nc-border);
  }
  .quick-reactions button {
    display: grid;
    place-items: center;
    width: 36px;
    height: 38px;
    border-radius: 8px;
    font-size: 22px;
  }
</style>
