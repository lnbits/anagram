<script lang="ts">
  import { onMount } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import {
    authLinkTarget,
    watchAuthLinkPreview,
    type AuthLinkPreview,
  } from '#src/stores/nostr/authLinkPreview.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  let { href }: { href: string } = $props();
  let element: HTMLSpanElement;
  let visible = $state(false);
  let result = $state<{ href: string; preview: AuthLinkPreview } | null>(null);
  const preview = $derived(result?.href === href ? result.preview : null);
  $effect(() => {
    const requestedHref = href;
    const target = authLinkTarget(requestedHref);
    if (visible && target?.type === 'group')
      return watchAuthLinkPreview(
        target,
        (value) => (result = { href: requestedHref, preview: value }),
      );
  });
  onMount(() => {
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  });
</script>

<span class="group-invitation" bind:this={element}>
  <span class="action">{$translate('Join chat')}</span>
  {#if preview?.name}
    <span aria-hidden="true" class="picture"
      ><Avatar name={preview.name} picture={preview.picture} size={24} /></span
    >
    <strong title={preview.name}>{preview.name}</strong>
  {:else}<Icon name="group" />{/if}
</span>

<style>
  .group-invitation {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }
  .action,
  .picture {
    flex-shrink: 0;
  }
  .picture {
    display: inline-flex;
  }
  strong {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 700;
  }
</style>
