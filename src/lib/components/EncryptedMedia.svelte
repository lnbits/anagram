<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
  import { encryptedMediaService } from '#src/services/encryptedMediaService.ts';
  import {
    createEncryptedMediaLoader,
    type EncryptedMediaLoadState,
  } from '#src/services/encryptedMediaLoader.ts';
  import { formatMediaByteSize, resolveEncryptedMediaKind } from '#src/utils/encryptedMedia.ts';
  import { nearViewport } from '#src/lib/actions/nearViewport.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  // The parent re-creates this component when the attachment changes.
  export let attachment: MessageAttachmentMetadata;
  // Decrypt automatically once the attachment is near the viewport. Only set once the sender's
  // media is allowed (own, trusted, or revealed by the user), mirroring how images are shown.
  export let autoLoad = false;
  let player: HTMLMediaElement | undefined;
  let state: EncryptedMediaLoadState = { status: 'idle', objectUrl: '' };
  let playWhenReady = false;
  const loader = createEncryptedMediaLoader(encryptedMediaService, (next) => {
    state = next;
  });
  $: kind = resolveEncryptedMediaKind(attachment.mimeType)?.kind === 'audio' ? 'audio' : 'video';
  $: label =
    attachment.name?.trim() ||
    $translate(kind === 'audio' ? 'message.encryptedMedia.audio' : 'message.encryptedMedia.video');
  $: sizeLabel = formatMediaByteSize(attachment.size);
  $: if (player && playWhenReady) startPlayback(player);
  function load() {
    void loader.load(attachment);
  }
  // Browsers may refuse playback when decryption outlived the user gesture; the native controls
  // stay available for a second tap.
  function startPlayback(element: HTMLMediaElement) {
    playWhenReady = false;
    void tick().then(() => element.play().catch(() => undefined));
  }
  function requestPlayback() {
    playWhenReady = true;
    load();
  }
  onDestroy(() => loader.dispose());
</script>

<div
  use:nearViewport={{
    rootMargin: '200px 0px',
    enabled: autoLoad && state.status === 'idle',
    onvisible: load,
  }}
  class="encrypted-media"
  data-kind={kind}
  data-testid="message-encrypted-media"
  role="presentation"
  onclick={(event) => event.stopPropagation()}
>
  {#if state.objectUrl && kind === 'video'}<!-- svelte-ignore a11y_media_has_caption --><video
      bind:this={player}
      data-testid="message-encrypted-video"
      src={state.objectUrl}
      controls
      playsinline
      preload="metadata"
      aria-label={label}
    ></video>
  {:else if state.objectUrl}<audio
      bind:this={player}
      data-testid="message-encrypted-audio"
      src={state.objectUrl}
      controls
      preload="metadata"
      aria-label={label}
    ></audio>
  {:else}<div class="encrypted-media-placeholder" class:video={kind === 'video'}>
      <button
        type="button"
        class="icon-button"
        data-testid="message-encrypted-media-load"
        disabled={state.status === 'loading'}
        aria-label={$translate(
          state.status === 'failed' ? 'message.encryptedMedia.retry' : 'message.encryptedMedia.play',
        )}
        onclick={requestPlayback}
        ><Icon
          name={state.status === 'failed' ? 'refresh' : kind === 'audio' ? 'speaker' : 'video'}
        /></button
      >
      <div class="encrypted-media-details">
        <span class="encrypted-media-label">{label}</span>
        {#if state.status === 'failed'}<small class="error" data-testid="message-encrypted-media-failed"
            >{$translate('message.encryptedMedia.failed')}</small
          >{:else if state.status === 'loading'}<small>…</small>{:else if sizeLabel}<small
            >{sizeLabel}</small
          >{/if}
      </div>
    </div>{/if}
</div>

<style>
  .encrypted-media {
    width: 320px;
    max-width: 100%;
    margin: 10px 0;
  }
  video,
  audio {
    display: block;
    width: 100%;
  }
  video {
    max-height: 400px;
    border-radius: 10px;
    background: #000;
  }
  .encrypted-media-placeholder {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px 8px 8px;
    border-radius: 10px;
    background: var(--nc-surface-soft);
  }
  .encrypted-media-placeholder.video {
    aspect-ratio: 16 / 9;
  }
  .encrypted-media-details {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .encrypted-media-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    color: var(--nc-text-secondary);
  }
  small.error {
    color: var(--q-negative, #c10015);
  }
</style>
