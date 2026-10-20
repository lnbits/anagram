<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
  import PwaControls from '#src/lib/components/PwaControls.svelte';
  import AppPrompts from '#src/lib/components/AppPrompts.svelte';
  import Auth from '#src/lib/components/Auth.svelte';
  import Shell from '#src/lib/components/Shell.svelte';
  import { applyThemeAccent, readThemeAccent, ACCENT_STORAGE_KEY } from '#src/utils/themeAccent.ts';
  import { incomingMessageBanner } from '#src/lib/platform/ui.ts';
  import { updateAppBadge } from '#src/lib/platform/appBadge.ts';
  import '#src/app.css';
  import '#src/lib/components/shell.css';
  let authenticated = false;
  let ready = false;
  onMount(() => {
    applyThemeAccent(readThemeAccent());
    const syncAccent = (event: StorageEvent) => {
      if (event.key === ACCENT_STORAGE_KEY || event.key === null)
        applyThemeAccent(readThemeAccent());
    };
    window.addEventListener('storage', syncAccent);
    document.body.classList.toggle(
      'body--dark',
      (localStorage.getItem('anagram-theme') ?? 'dark') === 'dark',
    );
    // Clean-URL hosting or an older app-shell cache can send share pages here.
    // Keep the validated destination in the route throughout login and onboarding.
    if (/^\/join\/chat(?:\.html)?\/?$/.test(window.location.pathname)) {
      const target = publicGroupLinkTarget(window.location.href);
      if (target) void goto(target, { replace: true });
    }
    authenticated =
      Boolean(localStorage.getItem('npub')) && !localStorage.getItem('anagram-onboarding-pending');
    if (!authenticated) void updateAppBadge(0);
    ready = true;
    return () => window.removeEventListener('storage', syncAccent);
  });
</script>

<PwaControls />
<AppPrompts />
{#if ready}{#if authenticated}<Shell />{:else}<Auth
      onlogin={() => (authenticated = true)}
    />{/if}{/if}
{#if $incomingMessageBanner}<div class="message-banner" role="status">
    {$incomingMessageBanner}
  </div>{/if}
