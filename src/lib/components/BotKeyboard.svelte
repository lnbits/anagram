<script lang="ts">
  import { onDestroy, setContext, type Snippet } from 'svelte';
  import { BOT_KEYBOARD_LAYOUT, type BotKeyboardLayout } from '#src/lib/botKeyboardLayout.ts';
  import FormattedMessage from './FormattedMessage.svelte';
  import { formatMessage, collapseFormattedMessage } from '#src/utils/messageFormatting.ts';
  import { collapseKeyboardSections } from '#src/utils/keyboardTextExpansion.ts';
  import { shouldCollapseMessageText } from '#src/utils/messageTextExpansion.ts';
  import { translate } from '#src/i18n.ts';
  import type { Message } from '#src/types/chat.ts';
  import {
    parseKeyboard,
    keyboardSections,
    safeMagnetUrl,
    validTarget,
    targetKey,
    type BotTarget,
    type InlineButton,
  } from '#src/stores/nostr/botKeyboardProtocol.ts';
  import { useNostrStore } from '#src/stores/nostrStore.svelte.ts';
  import type { BotInteraction } from '#src/services/botInteractionData.ts';
  import { openExternalHttpUrl, openExternalMagnetUrl } from '#src/utils/externalLinks.ts';
  import { readMessageEditPreviousEventIds } from '#src/utils/messageEdits.ts';

  let { message, children }: { message: Message; children: Snippet } = $props();
  const nostr = useNostrStore(),
    runtime = nostr.botKeyboards,
    changes = runtime.changes;
  let saved = $state<BotInteraction | undefined>();
  let sending = $state(false),
    error = $state('');
  let copied = $state('');
  let generation = 0,
    loadedKey = '';
  const keyboard = $derived(parseKeyboard(message.meta.inline_keyboard));
  const target = $derived<BotTarget>({
    type: message.meta.inline_keyboard_chat_type as BotTarget['type'],
    chat: message.chatId,
    root:
      message.meta.inline_keyboard_chat_type === 'public'
        ? message.id
        : (readMessageEditPreviousEventIds(message.meta)[0] ?? message.eventId ?? message.id),
    version: message.meta.inline_keyboard_version as string,
    bot: message.authorPublicKey,
  });
  $effect(() => {
    const next = target;
    const change = $changes.key;
    const key = `${nostr.getLoggedInPublicKeyHex()}:${JSON.stringify(next)}`;
    if (key === loadedKey && change !== null && change !== targetKey(next)) return;
    const token = ++generation;
    if (key !== loadedKey) {
      saved = undefined;
      loadedKey = key;
    }
    if (validTarget(next))
      void runtime
        .read(next)
        .then((value) => {
          if (token === generation) saved = value;
        })
        .catch(() => {
          if (token === generation) error = 'Could not read bot interaction';
        });
  });
  onDestroy(() => {
    generation++;
  });
  const personal = $derived(saved?.answer ?? saved?.previous);
  // IndexedDB refreshes return new objects for the same answer. Only a new
  // event should reset the reader's choice to expand the reply.
  const personalEventId = $derived(personal?.eventId);
  let personalExpanded = $state(false);
  $effect(() => {
    personalEventId;
    personalExpanded = false;
  });
  const personalFormatted = $derived(formatMessage(personal?.text ?? ''));
  const personalParts = $derived(
    personalExpanded ? personalFormatted : collapseFormattedMessage(personalFormatted),
  );
  const visibleKeyboard = $derived(personal?.keyboard ?? keyboard);
  const sections = $derived(
    keyboard &&
      validTarget(target) &&
      !message.meta.deleted &&
      (personal ||
        (target.type !== 'public' &&
          !message.meta.attachments?.length &&
          !message.meta.call_history &&
          !message.meta.group_epoch_notice))
      ? keyboardSections(visibleKeyboard, personal?.text ?? message.text)
      : null,
  );
  const personalSections = $derived(
    personalExpanded ? sections : collapseKeyboardSections(sections),
  );
  setContext<BotKeyboardLayout>(BOT_KEYBOARD_LAYOUT, {
    get messageId() {
      return message.id;
    },
    get sections() {
      return personal ? null : sections;
    },
    buttons,
  });
  async function click(button: InlineButton, retry = false) {
    if (sending) return;
    const current = target;
    sending = true;
    error = '';
    copied = '';
    try {
      if (button.copy_text) {
        await navigator.clipboard.writeText(button.copy_text.text);
        copied = `Copied ${button.text}`;
      } else if (button.url) {
        if (safeMagnetUrl(button.url)) await openExternalMagnetUrl(button.url);
        else await openExternalHttpUrl(button.url);
      } else {
        await runtime.click(
          current,
          button.callback_data!,
          personal?.keyboard ? personal.eventId : undefined,
          retry,
        );
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Bot interaction failed';
    } finally {
      sending = false;
    }
  }
</script>

{#snippet buttons(row: InlineButton[])}
  <div class="button-row">
    {#each row as button}
      <button
        type="button"
        data-size={button.size ?? 'medium'}
        disabled={sending}
        title={button.url ?? undefined}
        onclick={() => click(button)}>{button.text}{button.url ? ' ↗' : ''}</button
      >
    {/each}
  </div>
{/snippet}

{#if keyboard && validTarget(target) && !message.meta.deleted}
  <div class="bot-keyboard" data-testid="bot-keyboard">
    {#if personal}
      <div class="personal" data-testid="bot-personal-response">
        {#if personalSections}
          {#each personalSections as section}
            <div class="keyboard-section" data-testid="bot-keyboard-section">
              <p><FormattedMessage parts={formatMessage(section.text)} /></p>
              {#if section.row.length}{@render buttons(section.row)}{/if}
            </div>
          {/each}
        {:else}
          <p><FormattedMessage parts={personalParts} /></p>
        {/if}
        {#if shouldCollapseMessageText(personal.text)}
          <button class="link" onclick={() => (personalExpanded = !personalExpanded)}
            >{$translate(personalExpanded ? 'Show less' : 'Show more')}</button
          >
        {/if}
      </div>
    {:else}
      {@render children()}
    {/if}
    {#if !sections}
      {#each visibleKeyboard?.inline_keyboard ?? [] as row}{@render buttons(row)}{/each}
    {/if}
    {#if copied}<span class="copy-status" role="status">{copied}</span>{/if}
    {#if saved && !saved.answer}
      <div class="pending" role="status">
        {sending ? 'Sending…' : 'Waiting for bot response.'}
        <button
          type="button"
          disabled={sending}
          onclick={() => click({ text: 'Retry', callback_data: saved!.request.data! }, true)}
          >Retry</button
        >
      </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{:else}
  {@render children()}
{/if}

<style>
  .bot-keyboard {
    display: grid;
    gap: 0.35rem;
    max-width: 100%;
  }
  .button-row {
    display: flex;
    gap: 0.35rem;
  }
  .button-row button {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border, #75869a);
    border-radius: 0.5rem;
    background: var(--surface, transparent);
    color: inherit;
    font: inherit;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .button-row button[data-size='small'] {
    flex: 0 1 auto;
    min-height: 28px;
    padding: 0.2rem 0.45rem;
    font-size: 0.8rem;
  }
  .button-row button[data-size='large'] {
    min-height: 52px;
    padding: 0.7rem 0.9rem;
    font-size: 1.1rem;
  }
  .copy-status {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  @media (pointer: coarse) {
    .button-row button[data-size='small'] {
      min-height: 44px;
    }
  }
  button:focus-visible {
    outline: 2px solid var(--primary, #5caef5);
    outline-offset: 2px;
  }
  .personal p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0.25rem 0 0.5rem;
  }
  .keyboard-section + .keyboard-section {
    margin-top: 1rem;
  }
  .pending {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .pending button {
    margin-left: 0.5rem;
    background: transparent;
    color: inherit;
    border: 0;
    text-decoration: underline;
    min-height: 44px;
    cursor: pointer;
  }
  .error {
    color: var(--danger, #d95363);
    margin: 0.25rem 0;
    font-size: 0.85rem;
  }
</style>
