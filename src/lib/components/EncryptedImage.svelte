<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
  import { encryptedMediaService } from '#src/services/encryptedMediaService.ts';
  import {
    createEncryptedMediaLoader,
    type EncryptedMediaLoadState,
  } from '#src/services/encryptedMediaLoader.ts';
  import { nearViewport } from '#src/lib/actions/nearViewport.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  // The parent re-creates this component when the attachment changes.
  export let attachment: MessageAttachmentMetadata;
  export let alt = 'Attachment';
  export let onopen: () => void = () => {};
  let state: EncryptedMediaLoadState = { status: 'idle', objectUrl: '' };
  // The ciphertext URL is never used as an image source; only the verified, decrypted object URL.
  const loader = createEncryptedMediaLoader(encryptedMediaService, (next) => {
    state = next;
  });
  onDestroy(() => loader.dispose());
</script>

{#if state.objectUrl}<button
    type="button"
    class="encrypted-image"
    data-testid="message-encrypted-image"
    aria-label={alt}
    onclick={(event) => {
      event.stopPropagation();
      onopen();
    }}><img src={state.objectUrl} {alt} /></button
  >{:else}<div
    use:nearViewport={{
      // Encrypted images are only downloaded and decrypted once they are close to the viewport,
      // so opening a long conversation does not fetch every image in it.
      rootMargin: '600px 0px',
      onvisible: () => void loader.load(attachment),
    }}
    class="encrypted-placeholder"
    role="img"
    aria-label={alt}
    data-testid={state.status === 'failed'
      ? 'message-encrypted-image-failed'
      : 'message-encrypted-image-pending'}
  >
    {#if state.status === 'failed'}<button
        type="button"
        class="icon-button"
        aria-label={$translate('message.encryptedMedia.retry')}
        title={$translate('message.encryptedMedia.failed')}
        onclick={(event) => {
          event.stopPropagation();
          void loader.load(attachment);
        }}><Icon name="refresh" /></button
      >{:else}<Icon name="lock" />{/if}
  </div>{/if}

<style>
  .encrypted-image {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
  }
  img {
    display: block;
    max-width: min(100%, 480px);
    max-height: 400px;
    border-radius: 10px;
    margin: 10px 0;
  }
  .encrypted-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 160px;
    max-width: 100%;
    height: 120px;
    margin: 10px 0;
    border-radius: 10px;
    color: var(--nc-text-secondary);
    background: var(--nc-surface-soft);
  }
</style>
