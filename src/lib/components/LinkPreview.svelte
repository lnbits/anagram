<script lang="ts">
  import { onDestroy } from 'svelte';
  import { loadLinkPreview, loadPreviewImage } from '#src/services/linkPreviewService.ts';
  import { previewUrl, type LinkPreview } from '#src/utils/linkPreview.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  export let url: string;
  export let allowed = false;
  export let onopen: (url: string) => void;
  let revealed = false;
  let visible = false;
  let preview: LinkPreview | null = null;
  let imageUrl = '';
  let imageRequest: AbortController | null = null;
  function clearImage() {
    imageRequest?.abort();
    imageRequest = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = '';
  }
  let revision = 0;
  let disposed = false;
  $: void refresh(url, visible && (allowed || revealed));
  async function refresh(value: string, enabled: boolean) {
    const request = ++revision;
    preview = null;
    clearImage();
    if (!enabled) return;
    const target = previewUrl(value);
    const nostr = useNostrStore();
    if (!target || nostr.containsSessionSecret(decodeURIComponent(target))) return;
    const result = await loadLinkPreview(target);
    if (!disposed && request === revision && result) {
      preview = {
        ...result,
        image:
          result.image && !nostr.containsSessionSecret(decodeURIComponent(result.image))
            ? result.image
            : '',
      };
      if (preview.image) {
        imageRequest = new AbortController();
        const blob = await loadPreviewImage(preview.image, imageRequest.signal);
        if (blob && !disposed && request === revision) imageUrl = URL.createObjectURL(blob);
      }
    }
  }
  function watch(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          visible = true;
          observer.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
  onDestroy(() => {
    disposed = true;
    revision++;
    clearImage();
  });
</script>

<div class="preview-container" use:watch>
  {#if !allowed && !revealed}
    <button class="link load-preview" onclick={() => (revealed = true)}>Load link preview</button>
  {:else if preview}
    <a
      class="link-preview"
      data-testid="message-link-preview"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onclick={(event) => {
        event.preventDefault();
        onopen(url);
      }}
    >
      <span class="preview-copy"
        ><small>{preview.site}</small><strong>{preview.title}</strong>
        {#if preview.description}<span class="description">{preview.description}</span>{/if}
      </span>
      {#if imageUrl}<img
          src={imageUrl}
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          onerror={clearImage}
        />{/if}
    </a>
  {/if}
</div>

<style>
  .preview-container {
    display: block;
    max-width: 100%;
    min-height: 1px;
  }
  .link-preview {
    display: flex;
    gap: 12px;
    width: 440px;
    max-width: 100%;
    margin: 8px 0 4px;
    padding: 10px 12px;
    border-left: 3px solid var(--q-primary);
    border-radius: 4px 10px 10px 4px;
    background: color-mix(in srgb, var(--q-primary) 12%, transparent);
    color: var(--nc-text);
    text-decoration: none;
    white-space: normal;
    box-sizing: border-box;
  }
  .link-preview:hover {
    background: color-mix(in srgb, var(--q-primary) 20%, transparent);
  }
  .link-preview:focus-visible {
    outline: 2px solid var(--q-primary);
    outline-offset: 2px;
  }
  .preview-copy {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  small,
  strong,
  .description {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  small {
    color: var(--q-primary);
    font-size: 12px;
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  strong {
    font-size: 14px;
    margin: 3px 0;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .description {
    font-size: 13px;
    line-height: 1.4;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  img {
    width: 72px;
    height: 72px;
    object-fit: cover;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .load-preview {
    font-size: 12px;
    margin-top: 6px;
  }
  @media (max-width: 480px) {
    .link-preview {
      gap: 8px;
      padding: 8px;
    }
    img {
      width: 52px;
      height: 52px;
    }
  }
</style>
