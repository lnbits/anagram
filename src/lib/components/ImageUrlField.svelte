<script lang="ts">
  import { onDestroy } from 'svelte';
  import { uploadBlossomMedia } from '#src/services/blossomUploadService.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { previewUrl } from '#src/utils/linkPreview.ts';

  export let value: string | undefined = '';
  export let label = 'Picture URL';
  export let kind: 'picture' | 'banner' = 'picture';
  export let disabled = false;
  export let uploading = false;
  export let compact = false;
  export let testId: string | undefined = undefined;
  export let contextKey = '';
  export let onchange: () => void = () => {};

  const nostr = useNostrStore();
  let input: HTMLInputElement;
  let controller: AbortController | undefined;
  let error = '';

  function cancel() {
    controller?.abort();
    controller = undefined;
    uploading = false;
    if (input) input.value = '';
  }
  onDestroy(cancel);

  async function upload() {
    const file = input.files?.[0];
    if (!file || disabled || uploading) return;
    error = '';
    if (!file.type.startsWith('image/')) {
      error = 'Choose an image file.';
      input.value = '';
      return;
    }
    const account = nostr.getLoggedInPublicKeyHex();
    const target = contextKey;
    const request = new AbortController();
    controller = request;
    uploading = true;
    onchange();
    const current = () =>
      !request.signal.aborted &&
      target === contextKey &&
      account === nostr.getLoggedInPublicKeyHex();
    try {
      const result = await uploadBlossomMedia(file, {
        serverUrl: nostr.getBlossomServerUrl(),
        signal: request.signal,
        signUploadAuthHeader: async (options) => {
          if (!current()) throw new Error('Upload cancelled.');
          const header = await nostr.signBlossomUploadAuthHeader(options);
          if (!current()) throw new Error('Upload cancelled.');
          return header;
        },
      });
      if (!current()) return;
      const url = previewUrl(result.attachment.url);
      if (!url || !result.attachment.mimeType?.startsWith('image/'))
        throw new Error('The upload server did not return a public image URL.');
      value = url;
      onchange();
    } catch (cause) {
      if (current()) error = cause instanceof Error ? cause.message : 'Unable to upload image.';
    } finally {
      if (controller === request) {
        controller = undefined;
        uploading = false;
        input.value = '';
      }
    }
  }
</script>

<div class="image-url-field" class:compact>
  <div class="controls">
    <label class:profile-field={compact} class:filled={!!value} class:standard={!compact}>
      <span>{label}</span>
      <input
        bind:value
        disabled={disabled || uploading}
        data-testid={testId}
        placeholder={compact ? undefined : 'https://…'}
        spellcheck="false"
        oninput={() => {
          error = '';
          onchange();
        }}
      />
    </label>
    <button
      type="button"
      class="outline"
      disabled={disabled || uploading}
      onclick={() => input.click()}>{uploading ? 'Uploading…' : `Upload ${kind}`}</button
    >
    {#if uploading}<button type="button" class="outline" onclick={cancel}>Cancel upload</button
      >{/if}
  </div>
  <input
    bind:this={input}
    type="file"
    accept="image/*"
    aria-label={`Choose ${kind}`}
    disabled={disabled || uploading}
    onchange={upload}
    hidden
  />
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .image-url-field {
    min-width: 0;
  }
  .image-url-field:not(.compact) {
    margin: 16px 0;
  }
  .controls {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
  .controls > label {
    flex: 1 1 180px;
    min-width: 0;
    margin: 0;
  }
  .standard {
    display: grid;
    gap: 6px;
  }
  input:not([type='file']) {
    margin-top: 0;
    width: 100%;
    min-width: 0;
  }
  button {
    flex-shrink: 0;
    min-height: 40px;
  }
  input[hidden] {
    display: none;
  }
  .error {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }
</style>
