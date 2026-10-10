<script lang="ts">
  import { dismissOnOutside } from '#src/lib/actions/dismissOnOutside.ts';
  import { tick } from 'svelte';
  import type { NostrMentionProfile } from '#src/utils/nostrMentions.ts';
  export let mentionProfiles: NostrMentionProfile[] = [];
  import { autosizeTextarea } from '#src/lib/actions/autosizeTextarea.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  export let draft = '';
  export let input: HTMLTextAreaElement = undefined!;
  export let fileInput: HTMLInputElement = undefined!;
  export let emoji = false;
  export let attachmentMenu = false;
  export let disabled = false;
  export let busy = false;
  export let attachDisabled = false;
  export let allowAttachments = true;
  export let onattachUnavailable: (() => void) | undefined = undefined;
  export let allowFiles = true;
  export let accept = 'image/*,video/*,audio/*';
  export let label = 'Message';
  export let placeholder = 'Write a message';
  export let attachLabel = 'Attach media';
  export let maxlength: number | undefined = undefined;
  export let onsend: () => void;
  export let onfile: (file?: File) => void;
  export let onchange: () => void = () => {};
  // Escape cancels a reply or edit once nothing else in the composer is open.
  export let oncancel: (() => void) | undefined = undefined;
  function chooseUpload(types: string) {
    attachmentMenu = false;
    fileInput.accept = types;
    fileInput.click();
  }
  function prepareUpload(file?: File) {
    if (allowAttachments && !disabled && !busy && !attachDisabled) onfile(file);
  }
  function insertEmoji(value: string) {
    const start = input?.selectionStart ?? draft.length,
      end = input?.selectionEnd ?? start;
    draft = draft.slice(0, start) + value + draft.slice(end);
    onchange();
    emoji = false;
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(start + value.length, start + value.length);
    });
  }
  let emojiTrigger: HTMLButtonElement;
  let attachmentTrigger: HTMLButtonElement;
  let autocompleteIndex = 0,
    dismissedAutocomplete = '',
    composerCursor = 0;
  let emojiEntries: typeof import('#src/data/topEmojis.ts').TOP_EMOJIS = [];
  let emojiLoad: Promise<void> | undefined;
  $: beforeCursor = draft.slice(0, composerCursor);
  $: emojiQuery = /(?:^|\s):([\w+-]*)$/.exec(beforeCursor)?.[1];
  $: if (emojiQuery !== undefined && !emojiLoad)
    emojiLoad = import('#src/data/topEmojis.ts').then((module) => {
      emojiEntries = module.TOP_EMOJIS;
    });
  $: emojiSuggestions =
    emojiQuery !== undefined && dismissedAutocomplete !== beforeCursor
      ? emojiEntries
          .filter((e) => e.label.includes(emojiQuery!.toLowerCase().replaceAll('_', ' ')))
          .slice(0, 8)
      : [];

  $: mentionQuery = /(?:^|\s)@([\w-]*)$/.exec(beforeCursor)?.[1];
  $: mentionSuggestions =
    mentionQuery !== undefined && dismissedAutocomplete !== beforeCursor
      ? mentionProfiles
          .filter(
            (p) =>
              p.displayName.toLowerCase().includes(mentionQuery!.toLowerCase()) ||
              p.handle.toLowerCase().startsWith(mentionQuery!.toLowerCase()),
          )
          .slice(0, 8)
      : [];
  function updateComposerCursor() {
    composerCursor = input?.selectionStart ?? draft.length;
    autocompleteIndex = 0;
  }
  function replaceAutocomplete(value: string, kind: '@' | ':') {
    const start = beforeCursor.lastIndexOf(kind);
    draft = draft.slice(0, start) + value + ' ' + draft.slice(composerCursor);
    composerCursor = start + value.length + 1;
    onchange();
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(composerCursor, composerCursor);
    });
  }
  function insertMention(handle: string) {
    replaceAutocomplete('@' + handle, '@');
  }
  function composerKey(event: KeyboardEvent) {
    const count = mentionSuggestions.length || emojiSuggestions.length;
    if (
      count &&
      ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key) &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (event.key === 'Escape') dismissedAutocomplete = beforeCursor;
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
        autocompleteIndex =
          (autocompleteIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      else if (mentionSuggestions.length)
        insertMention(
          mentionSuggestions[autocompleteIndex]?.handle ?? mentionSuggestions[0].handle,
        );
      else
        replaceAutocomplete(
          emojiSuggestions[autocompleteIndex]?.emoji ?? emojiSuggestions[0].emoji,
          ':',
        );
      return;
    }
    if (event.key === 'Escape' && oncancel && !emoji && !attachmentMenu && !event.isComposing) {
      event.preventDefault();
      oncancel();
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      emoji = false;
      attachmentMenu = false;
    }
  }}
/>

{#if emoji && !disabled}<div
    class="composer-picker"
    use:dismissOnOutside={{ dismiss: () => (emoji = false), trigger: emojiTrigger }}
  >
    <EmojiPicker onselect={insertEmoji} />
  </div>{/if}
{#if attachmentMenu && allowAttachments && !disabled}<div
    class="attachment-menu"
    use:dismissOnOutside={{ dismiss: () => (attachmentMenu = false), trigger: attachmentTrigger }}
  >
    <button onclick={() => chooseUpload(accept)}>{$translate('message.photoOrVideo')}</button>
    {#if allowFiles}<button onclick={() => chooseUpload('*/*')}>{$translate('message.file')}</button
      >{/if}
  </div>{/if}
{#if mentionSuggestions.length}<div
    class="mention-suggestions"
    role="listbox"
    aria-label="Mention suggestions"
  >
    {#each mentionSuggestions as profile, index}<button
        type="button"
        role="option"
        aria-selected={autocompleteIndex === index}
        data-testid="message-mention-option"
        onclick={() => insertMention(profile.handle)}
        >{profile.displayName} <small>@{profile.handle}</small></button
      >{/each}
  </div>{/if}
{#if emojiSuggestions.length && !mentionSuggestions.length}<div
    class="mention-suggestions"
    role="listbox"
    aria-label="Emoji suggestions"
  >
    {#each emojiSuggestions as entry, index}<button
        type="button"
        role="option"
        aria-selected={autocompleteIndex === index}
        onclick={() => replaceAutocomplete(entry.emoji, ':')}
        >{entry.emoji} <small>{entry.label}</small></button
      >{/each}
  </div>{/if}
<form
  class="composer"
  onsubmit={(event) => {
    event.preventDefault();
    if (!disabled && !busy && draft.trim()) onsend();
  }}
>
  <div class="composer-input">
    {#if allowAttachments || onattachUnavailable}<button
        type="button"
        class="icon-button"
        aria-label={attachLabel}
        bind:this={attachmentTrigger}
        aria-expanded={allowAttachments && allowFiles ? attachmentMenu : undefined}
        data-testid="message-composer-menu"
        disabled={disabled || busy || attachDisabled}
        onclick={() => {
          if (!allowAttachments) onattachUnavailable?.();
          else if (allowFiles) attachmentMenu = !attachmentMenu;
          else chooseUpload(accept);
        }}><Icon name="attach" /></button
      >{/if}
    <textarea
      bind:value={draft}
      bind:this={input}
      use:autosizeTextarea={draft}
      {disabled}
      onpaste={(event) => {
        const file = event.clipboardData?.files[0];
        if (file && allowAttachments && !attachDisabled) {
          event.preventDefault();
          prepareUpload(file);
        }
      }}
      ondragover={(event) => {
        if (allowAttachments) event.preventDefault();
      }}
      ondrop={(event) => {
        event.preventDefault();
        prepareUpload(event.dataTransfer?.files[0]);
      }}
      aria-label={label}
      {placeholder}
      {maxlength}
      rows="1"
      data-testid="message-composer-input"
      oninput={(event) => {
        draft = event.currentTarget.value;
        dismissedAutocomplete = '';
        onchange();
        updateComposerCursor();
      }}
      onclick={updateComposerCursor}
      onkeyup={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateComposerCursor();
      }}
      onkeydown={(event) => {
        composerKey(event);
        if (
          !event.defaultPrevented &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.isComposing
        ) {
          event.preventDefault();
          if (!disabled && !busy && draft.trim()) onsend();
        }
      }}></textarea>
    <button
      type="button"
      class="icon-button"
      aria-label="Emoji"
      bind:this={emojiTrigger}
      aria-expanded={emoji}
      data-testid="message-composer-emoji"
      {disabled}
      onclick={() => (emoji = !emoji)}><Icon name="smile" /></button
    >
    {#if allowAttachments}<input
        hidden
        type="file"
        {accept}
        bind:this={fileInput}
        onchange={(event) => prepareUpload(event.currentTarget.files?.[0])}
      />{/if}
  </div>
  <button
    class="send-button"
    aria-label="Send message"
    data-testid="message-send-button"
    disabled={disabled || busy || !draft.trim()}><Icon name="send" /></button
  >
</form>
