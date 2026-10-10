<script lang="ts">
  import { onMount } from 'svelte';
  import { dev } from '$app/env';
  type InstallPrompt = Event & {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  let installPrompt: InstallPrompt | null = null;
  let updateReady = false;
  let dismissed = false;
  async function install() {
    const prompt = installPrompt;
    installPrompt = null;
    await prompt?.prompt();
  }
  onMount(() => {
    if (
      dev ||
      '__TAURI_INTERNALS__' in window ||
      !window.isSecureContext ||
      !('serviceWorker' in navigator)
    )
      return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let lastCheck = Date.now();
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      installPrompt = event as InstallPrompt;
    };
    const installed = () => {
      installPrompt = null;
    };
    const check = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > 15 * 60 * 1000) {
        lastCheck = Date.now();
        void registration?.update().catch(() => {});
      }
    };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installed);
    document.addEventListener('visibilitychange', check);
    void navigator.serviceWorker
      .register('/service-worker.js', { type: 'module', updateViaCache: 'none' })
      .then((value) => {
        if (disposed) return;
        registration = value;
        updateReady = Boolean(value.waiting && navigator.serviceWorker.controller);
        value.addEventListener('updatefound', () => {
          const worker = value.installing;
          worker?.addEventListener('statechange', () => {
            if (!disposed && worker.state === 'installed' && navigator.serviceWorker.controller)
              updateReady = true;
          });
        });
      })
      .catch(() => {
        /* Online use remains available if storage/registration is denied. */
      });
    return () => {
      disposed = true;
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
      document.removeEventListener('visibilitychange', check);
    };
  });
</script>

{#if !dismissed && (updateReady || installPrompt)}
  <aside class="pwa-banner" aria-label="Anagram app" aria-live="polite">
    {#if updateReady}
      <span>An update is ready. Close all Anagram windows and reopen to update.</span>
    {:else}
      <button onclick={install}>Install Anagram</button>
    {/if}
    <button aria-label="Dismiss app notice" onclick={() => (dismissed = true)}>✕</button>
  </aside>
{/if}

<style>
  .pwa-banner {
    position: fixed;
    top: max(8px, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: calc(100vw - 24px);
    padding: 8px 12px;
    border-radius: 10px;
    background: #243442;
    color: #edf4fa;
    box-shadow: 0 3px 12px #0006;
    font-size: 13px;
  }
  button {
    color: inherit;
    background: transparent;
    border: 0;
    padding: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
</style>
