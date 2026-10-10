<script lang="ts">
  import { onMount } from 'svelte';
  import PwaControls from '#src/lib/components/PwaControls.svelte';
  import Auth from '#src/lib/components/Auth.svelte';
  import Shell from '#src/lib/components/Shell.svelte';
  import { applyThemeAccent, readThemeAccent, ACCENT_STORAGE_KEY } from '#src/utils/themeAccent.ts';
  import { notices } from '#src/lib/platform/ui.ts';
  import { noticesFollowModal } from '#src/lib/actions/noticesFollowModal.ts';
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
    authenticated =
      Boolean(localStorage.getItem('npub')) && !localStorage.getItem('anagram-onboarding-pending');
    ready = true;
    return () => window.removeEventListener('storage', syncAccent);
  });
</script>

<PwaControls />
{#if ready}{#if authenticated}<Shell />{:else}<Auth
      onlogin={() => (authenticated = true)}
    />{/if}{/if}
<div class="notices" aria-live="polite" use:noticesFollowModal={$notices.length}>
  {#each $notices as notice (notice.id)}<div class:error={notice.type === 'negative'}>
      {notice.message}
    </div>{/each}
</div>
