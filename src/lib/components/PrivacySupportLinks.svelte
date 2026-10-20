<script lang="ts">
  import { translate } from '#src/i18n.ts';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';

  let error = '';
  async function open(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    const url = (event.currentTarget as HTMLAnchorElement).href;
    error = '';
    try {
      await openExternalHttpUrl(url);
    } catch {
      error = $translate('common.tryAgain');
    }
  }
</script>

<nav class="privacy-support-links" aria-label={$translate('Privacy and support')}>
  <a
    href="https://chat.nostr.com/privacy.html"
    target="_blank"
    rel="noopener noreferrer"
    onclick={open}>{$translate('Privacy policy')}</a
  >
  <a
    href="https://chat.nostr.com/support.html"
    target="_blank"
    rel="noopener noreferrer"
    onclick={open}>{$translate('Support')}</a
  >
</nav>
{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  .privacy-support-links {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px 20px;
    padding: 12px 16px;
    font-size: 13px;
  }
  a {
    color: inherit;
    padding: 8px 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>
