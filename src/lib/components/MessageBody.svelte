<script lang="ts">
  import { getContext } from 'svelte';
  import { BOT_KEYBOARD_LAYOUT, type BotKeyboardLayout } from '#src/lib/botKeyboardLayout.ts';
  import { goto } from '$app/navigation';
  import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
  import type { Message } from '#src/types/chat.ts';
  import {
    formatMessage,
    collapseFormattedMessage,
    messageFormatUrls,
    withoutFormattedMediaUrls,
    type FormattedMessagePart,
  } from '#src/utils/messageFormatting.ts';
  import FormattedMessage from './FormattedMessage.svelte';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  import { parseRoomLink } from '#src/utils/callRoom.ts';
  import { readCallHistory, callHistoryDuration } from '#src/utils/callHistory.ts';
  import { useTrustedMediaStore } from '#src/stores/trustedMediaStore.svelte.ts';
  import { portal } from '#src/lib/actions/portal.ts';
  import { appViewportBounds } from '#src/lib/platform/viewportBounds.ts';
  import { toStore } from 'svelte/store';
  import { diagnosticText } from '#src/utils/diagnosticExport.ts';
  import { translate } from '#src/i18n.ts';
  import type { NostrMentionProfile } from '#src/utils/nostrMentions.ts';
  import Icon from './Icon.svelte';
  import { isSingleEmoji } from '#src/utils/singleEmoji.ts';
  import MediaViewer from './MediaViewer.svelte';
  import LinkPreview from './LinkPreview.svelte';
  import { previewUrl } from '#src/utils/linkPreview.ts';
  import { shouldCollapseMessageText } from '#src/utils/messageTextExpansion.ts';
  import { collapseKeyboardSections } from '#src/utils/keyboardTextExpansion.ts';
  import type { CallMode } from '#src/types/call.ts';

  interface Props {
    mentionProfiles?: NostrMentionProfile[];
    canRedial?: boolean;
    onredial?: (mode: CallMode) => void;
    message: Message;
    bubbleLayout?: boolean;
    // Public rooms supply their owner-authorized media policy and sanitized formatting.
    allowMedia?: boolean;
    allowLinkPreviews?: boolean;
    formattedParts?: FormattedMessagePart[] | undefined;
    oncontact: (pubkey: string) => void;
    onroom: (link: string) => void;
  }

  let {
    mentionProfiles = [],
    canRedial = false,
    onredial = () => {},
    message,
    bubbleLayout = false,
    allowMedia = false,
    allowLinkPreviews = false,
    formattedParts = undefined,
    oncontact,
    onroom,
  }: Props = $props();
  const trusted = useTrustedMediaStore();
  const keyboardLayout = getContext<BotKeyboardLayout | undefined>(BOT_KEYBOARD_LAYOUT);
  const keyboardSections = $derived(
    keyboardLayout?.messageId === message.id ? keyboardLayout.sections : null,
  );
  const trust = toStore(() => trusted.trustedImageSenderPublicKeys);
  let actionError = $state('');
  let imageUrl = $state('');
  let imageName = $state('');
  let expanded = $state(false),
    showMedia = $state(false);
  const visibleKeyboardSections = $derived(
    expanded ? keyboardSections : collapseKeyboardSections(keyboardSections),
  );
  async function open(url: string) {
    actionError = '';
    const publicGroup = publicGroupLinkTarget(url);
    if (publicGroup) {
      await goto(publicGroup);
      return;
    }
    if (parseRoomLink(url)) {
      onroom(url);
      return;
    }
    try {
      await openExternalHttpUrl(url);
    } catch (error) {
      actionError = diagnosticText(String(error));
    }
  }
  let linkMenu: { href: string; x: number; y: number; media?: boolean } | null = $state(null);
  let menuTrigger: HTMLButtonElement | null = null;
  function closeLinkMenu(restoreFocus = false) {
    linkMenu = null;
    if (restoreFocus) menuTrigger?.focus({ preventScroll: true });
    menuTrigger = null;
  }
  function mediaOptions(event: MouseEvent, href: string) {
    const button = event.currentTarget as HTMLButtonElement;
    if (linkMenu?.href === href) {
      closeLinkMenu(true);
      return;
    }
    menuTrigger = button;
    const rect = button.getBoundingClientRect();
    const viewport = appViewportBounds();
    linkMenu = {
      href,
      media: true,
      x: Math.max(viewport.left + 8, Math.min(rect.right - 160, viewport.right - 168)),
      y: Math.max(viewport.top + 8, Math.min(rect.bottom + 4, viewport.bottom - 100)),
    };
  }
  function focusMenu(node: HTMLElement) {
    if (menuTrigger) node.querySelector<HTMLButtonElement>('button')?.focus();
  }
  function dismissMenu(_node: HTMLElement) {
    const pointer = (event: PointerEvent) => {
      if (!(
        event.target instanceof Element &&
        event.target.closest('[data-message-link-menu], [data-media-options]')
      ))
        closeLinkMenu();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLinkMenu(true);
    };
    window.addEventListener('pointerdown', pointer);
    window.addEventListener('keydown', key);
    return {
      destroy() {
        window.removeEventListener('pointerdown', pointer);
        window.removeEventListener('keydown', key);
      },
    };
  }
  async function copyLink() {
    actionError = '';
    const href = linkMenu?.href;
    closeLinkMenu(true);
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      actionError = 'Could not copy link.';
    }
  }
  let history = $derived(readCallHistory(message.meta.call_history));
  // Legacy parents invalidate object props on unrelated history/status updates.
  // Gate parsing on the actual text and stable roster, not the whole message.
  let text = $derived(message.text);
  let profiles = $derived(mentionProfiles);
  let formatted = $derived(formattedParts ?? formatMessage(text, profiles));
  let formatUrls = $derived(messageFormatUrls(formatted));
  let attachments = $derived(
    (message.meta.attachments ?? []).filter((attachment) => {
      try {
        const href = new URL(attachment.url).href;
        return !formatUrls.hidden.has(href) || formatUrls.visible.has(href);
      } catch {
        return false;
      }
    }),
  );
  let mediaAllowed = $derived(
    allowMedia || showMedia || message.sender === 'me' || $trust.includes(message.authorPublicKey),
  );
  let content = $derived(
    mediaAllowed ? withoutFormattedMediaUrls(formatted, attachments) : formatted,
  );
  let parts = $derived(expanded ? content : collapseFormattedMessage(content));
  let previewLinks = $derived(
    !allowLinkPreviews
      ? []
      : [...messageFormatUrls(parts).visible]
          .filter(
            (href) =>
              !parseRoomLink(href) &&
              !publicGroupLinkTarget(href) &&
              previewUrl(href) &&
              !attachments.some((attachment) => attachment.url === href) &&
              !/\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|mp3|ogg|wav|pdf)(?:[?#]|$)/i.test(
                href,
              ),
          )
          .slice(0, 2),
  );
</script>

{#if actionError}<p class="error" role="alert">{actionError}</p>{/if}

{#if linkMenu && !message.meta.deleted}<div
    use:portal
    use:focusMenu
    use:dismissMenu
    class="link-menu"
    data-message-link-menu
    role="menu"
    style:left={`${linkMenu.x}px`}
    style:top={`${linkMenu.y}px`}
  >
    <button role="menuitem" data-testid="message-link-copy" onclick={copyLink}>Copy link</button>
    {#if linkMenu.media}<button
        role="menuitem"
        onclick={() => {
          const href = linkMenu?.href;
          closeLinkMenu(true);
          if (href) void open(href);
        }}>Open original</button
      >{/if}
  </div>{/if}

{#if message.meta.deleted}<em class="message-text" data-testid="message-deleted">Message deleted</em
  >
{:else if history}<div class="call-history" data-testid="message-call-history">
    <button
      class="icon-button"
      data-testid="message-call-again"
      aria-label={$translate('call.again')}
      disabled={!canRedial}
      onclick={() => history && onredial(history.mode)}><Icon name="phone" /></button
    >
    <div>
      <div>
        {$translate(history.mode === 'video' ? 'call.history.video' : 'call.history.audio')}
      </div>
      <small
        >{$translate(message.sender === 'me' ? 'call.history.outgoing' : 'call.history.incoming')} · {history.connected
          ? callHistoryDuration(history.duration)
          : $translate(`call.history.${history.reason}`)}</small
      >
    </div>
  </div>
{:else if message.meta.group_epoch_notice}<span class="epoch-notice"
    >{$translate('Group keys updated')} · {message.text}</span
  >
{:else}
  <div
    class="message-body"
    class:bubble-media-body={bubbleLayout &&
      mediaAllowed &&
      attachments.some(
        (attachment) =>
          /^(image|video)\//.test(attachment.mimeType) && /^https:\/\//.test(attachment.url),
      )}
  >
    {#if visibleKeyboardSections}
      {#each visibleKeyboardSections as section}
        <div class="keyboard-section" data-testid="bot-keyboard-section">
          <span class="message-text"
            ><FormattedMessage
              parts={formatMessage(section.text, profiles)}
              onopen={open}
              {oncontact}
            /></span
          >
          {#if section.row.length}{@render keyboardLayout!.buttons(section.row)}{/if}
        </div>
      {/each}
    {:else if parts.length}<span
        class="message-text"
        class:single-emoji={isSingleEmoji(message.text) && !message.meta.attachments?.length}
        ><FormattedMessage
          {parts}
          onopen={open}
          {oncontact}
          onlinkmenu={(event, href) => {
            event.preventDefault();
            event.stopPropagation();
            const viewport = appViewportBounds();
            linkMenu = {
              href,
              x: Math.max(viewport.left + 8, Math.min(event.clientX, viewport.right - 160)),
              y: Math.max(viewport.top + 8, Math.min(event.clientY, viewport.bottom - 55)),
            };
          }}
        /></span
      >
    {/if}
    {#if shouldCollapseMessageText(message.text)}<button
        class="link"
        onclick={() => (expanded = !expanded)}
        >{$translate(expanded ? 'Show less' : 'Show more')}</button
      >{/if}
    {#each previewLinks as url (url)}
      <LinkPreview {url} allowed={mediaAllowed} onopen={open} />
    {/each}
    {#if attachments.length && !mediaAllowed}<div class="media-prompt">
        <button class="outline" onclick={() => (showMedia = true)}
          >{$translate('Load media')}</button
        ><button class="link" onclick={() => trusted.trustImageSender(message.authorPublicKey)}
          >{$translate('Always load media from this sender')}</button
        >
      </div>{/if}
    {#if mediaAllowed}
      {#each attachments as attachment}
        {#if /^https:\/\//.test(attachment.url)}
          {#if /^(image|video)\//.test(attachment.mimeType)}
            <div class="media-attachment">
              {#if attachment.mimeType.startsWith('image/')}<a
                  href={attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onclick={(e) => {
                    e.preventDefault();
                    imageUrl = attachment.url;
                    imageName = attachment.name ?? 'attachment';
                  }}
                  ><img
                    src={attachment.url}
                    alt={attachment.name ?? 'Attachment'}
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  /></a
                >
              {:else}<!-- svelte-ignore a11y_media_has_caption --><video
                  src={attachment.url}
                  controls
                  preload="none"
                ></video>{/if}
              <div class="media-footer">
                <button
                  class="icon-button media-options"
                  data-media-options
                  aria-label="Media options"
                  title="Media options"
                  aria-haspopup="menu"
                  aria-expanded={linkMenu?.media === true && linkMenu.href === attachment.url}
                  onclick={(event) => mediaOptions(event, attachment.url)}
                  ><Icon name="more" /></button
                >
              </div>
            </div>
          {:else if attachment.mimeType.startsWith('audio/')}<audio
              src={attachment.url}
              controls
              preload="none"
            ></audio>
          {:else}<a
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              onclick={(e) => {
                e.preventDefault();
                void open(attachment.url);
              }}>{attachment.name ?? 'Download attachment'}</a
            >{/if}
        {/if}
      {/each}
    {/if}
  </div>
{/if}

{#if imageUrl && !message.meta.deleted}<MediaViewer
    url={imageUrl}
    name={imageName}
    onclose={() => (imageUrl = '')}
  />{/if}

<style>
  .keyboard-section {
    display: grid;
    gap: 0.4rem;
    min-width: 0;
  }
  .keyboard-section + .keyboard-section {
    margin-top: 1rem;
  }
  .message-body {
    display: contents;
  }
  .bubble-media-body {
    display: flex;
    flex-direction: column;
  }
  .bubble-media-body > .message-text,
  .bubble-media-body > .link {
    order: 1;
  }

  .link-menu {
    position: fixed;
    z-index: 100;
    padding: 6px;
    min-width: 140px;
    border: 1px solid var(--nc-border);
    border-radius: 8px;
    background: var(--nc-menu-bg);
    color: var(--nc-text);
    box-shadow: 0 4px 18px #0005;
  }
  .link-menu button {
    width: 100%;
    text-align: left;
    padding: 8px;
  }
  .message-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .single-emoji {
    font-size: 3em;
  }
  a {
    color: var(--q-primary);
  }
  .call-history {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .call-history small,
  .epoch-notice {
    color: var(--nc-text-secondary);
  }
  img,
  video {
    display: block;
    max-width: min(100%, 480px);
    max-height: 400px;
    border-radius: 10px;
    margin: 10px 0;
  }
  .media-attachment {
    width: fit-content;
    max-width: 100%;
  }
  .media-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: -6px;
  }
  .media-options {
    width: 28px;
    height: 28px;
  }
  .media-prompt {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  audio {
    max-width: 100%;
    margin: 10px 0;
  }
</style>
