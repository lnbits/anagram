<script lang="ts">
  import { page } from '$app/state';
  import {
    authLinkTarget,
    watchAuthLinkPreview,
    type AuthLinkPreview,
  } from '#src/stores/nostr/authLinkPreview.ts';
  import Avatar from './Avatar.svelte';

  let preview = $state<AuthLinkPreview | null>(null);
  const shortName = $derived.by(() => {
    const characters = Array.from(preview?.name || '');
    return characters.length > 15 ? `${characters.slice(0, 15).join('')}...` : characters.join('');
  });
  const target = $derived(authLinkTarget(page.url.href));
  $effect(() => {
    preview = null;
    return target ? watchAuthLinkPreview(target, (value) => (preview = value)) : undefined;
  });
</script>

{#if target && preview?.name}
  <div class="invite-banner">
    <div class="banner-content" data-testid="auth-link-banner" role="status">
      <span class="prefix">{target.type === 'group' ? 'Join the chat:' : 'Chat with:'}</span>
      <span class="name" title={preview.name}>{shortName}</span>
      <span class="picture" aria-hidden="true"
        ><Avatar
          name={preview?.name || '?'}
          picture={preview?.picture || ''}
          size={28}
          eager
        /></span
      >
    </div>
  </div>
{/if}

<style>
  .invite-banner {
    position: absolute;
    bottom: 100%;
    height: max(0px, calc((var(--app-viewport-height, 100dvh) - 100%) / 2));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    max-width: 100%;
    container-type: size;
    color: #fff;
    text-align: center;
    font-size: 15px;
    font-weight: 650;
    line-height: 1.35;
  }
  .prefix,
  .picture {
    flex-shrink: 0;
  }
  .prefix {
    white-space: nowrap;
  }
  .picture {
    display: inline-flex;
  }
  .banner-content {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }
  .name {
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
  }
  @container (max-height: 31px) {
    .banner-content {
      display: none;
    }
  }
</style>
