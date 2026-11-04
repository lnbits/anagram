<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
  import PwaControls from '#src/lib/components/PwaControls.svelte';
  import AppPrompts from '#src/lib/components/AppPrompts.svelte';
  import { hasPendingLogoutCleanup } from '#src/utils/logoutState.ts';
  import { applyThemeAccent, readThemeAccent, ACCENT_STORAGE_KEY } from '#src/utils/themeAccent.ts';
  import { incomingMessageBanner } from '#src/lib/platform/ui.ts';
  import { updateAppBadge } from '#src/lib/platform/appBadge.ts';
  import { isNativeSecureStorage } from '#src/lib/platform/secureKeys.ts';
  import { withDeadline } from '#src/utils/withDeadline.ts';
  import '#src/app.css';
  import '#src/lib/components/shell.css';
  let authenticated = false;
  let ready = false;
  let cleaning = false;
  let cleanupBusy = false;
  let cleanupError = '';
  let sessionBusy = false;
  let sessionError = '';
  let sessionCheck: Promise<boolean> | undefined;
  let mounted = false;
  let sessionGeneration = 0;
  async function restoreSession() {
    if (sessionBusy) return;
    const generation = ++sessionGeneration;
    sessionBusy = true;
    sessionError = '';
    ready = true;
    try {
      const hasAccount = Boolean(localStorage.getItem('npub'));
      if (hasAccount && isNativeSecureStorage()) {
        // WebView account metadata can outlive a deleted OS credential after
        // a forced exit. Validate before mounting Shell or starting its sync.
        // Retain a slow read across retries rather than queueing more OS work.
        const storage = await import('#src/services/electronSecurePrivateKeyStorage.ts');
        if (!mounted || generation !== sessionGeneration) return;
        sessionCheck ??= storage.hasUsableElectronPrivateKeySession().finally(() => {
          sessionCheck = undefined;
        });
        const usable = await withDeadline(sessionCheck, 8000, 'Session storage is still waiting.');
        if (!mounted || generation !== sessionGeneration) return;
        if (!usable) {
          // The credential is confirmed missing. Finish clearing account
          // caches before allowing another account to log in.
          void resumeLogout();
          return;
        }
      }
      authenticated = hasAccount && !localStorage.getItem('anagram-onboarding-pending');
      if (!authenticated) void updateAppBadge(0);
    } catch {
      if (mounted && generation === sessionGeneration)
        sessionError =
          'Unable to restore your saved session. Check your credential storage and retry.';
    } finally {
      if (mounted && generation === sessionGeneration) sessionBusy = false;
    }
  }
  async function resumeLogout() {
    if (cleanupBusy) return;
    sessionGeneration += 1;
    sessionBusy = false;
    sessionError = '';
    ready = true;
    cleaning = true;
    authenticated = false;
    cleanupBusy = true;
    cleanupError = '';
    try {
      const { useNostrStore } = await import('#src/stores/nostrStore.svelte.ts');
      await useNostrStore().logout();
      window.location.replace('/');
    } catch (error) {
      cleanupError =
        error instanceof Error ? error.message : 'Unable to finish logout. Please retry.';
    } finally {
      cleanupBusy = false;
    }
  }
  onMount(() => {
    mounted = true;
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
    window.addEventListener('anagram-logout', resumeLogout);
    if (hasPendingLogoutCleanup()) void resumeLogout();
    else void restoreSession();
    return () => {
      mounted = false;
      sessionGeneration += 1;
      window.removeEventListener('storage', syncAccent);
      window.removeEventListener('anagram-logout', resumeLogout);
    };
  });
</script>

<PwaControls />
<AppPrompts />
{#if ready}
  {#if cleaning}
    <main class="logout-cleanup" aria-live="polite">
      <p>{cleanupBusy ? 'Logging out…' : cleanupError}</p>
      <!-- Reload releases stuck storage handles; the pending marker resumes cleanup before login. -->
      {#if !cleanupBusy}<button onclick={() => window.location.reload()}>Retry logout</button>{/if}
    </main>
  {:else if sessionBusy || sessionError}
    <main class="logout-cleanup" aria-live="polite">
      <p>{sessionBusy ? 'Opening account…' : sessionError}</p>
      {#if !sessionBusy}
        <button onclick={restoreSession}>Retry session</button>
        <p>To sign in again, log out and clear this device’s saved account data.</p>
        <button onclick={resumeLogout}>Log out and clear local data</button>
      {/if}
    </main>
  {:else if authenticated}
    {#await import('#src/lib/components/Shell.svelte') then module}<module.default />{/await}
  {:else}
    {#await import('#src/lib/components/Auth.svelte') then module}<module.default
        onlogin={() => (authenticated = true)}
      />{/await}
  {/if}
{/if}
{#if $incomingMessageBanner}<div class="message-banner" role="status">
    {$incomingMessageBanner}
  </div>{/if}

<style>
  .logout-cleanup {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }
</style>
