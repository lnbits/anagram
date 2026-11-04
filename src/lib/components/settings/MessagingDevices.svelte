<script lang="ts">
  import { onMount } from 'svelte';
  import { useNostrStore } from '#src/stores/nostrStore.svelte.ts';
  import type { MessagingDevice } from '#src/stores/nostr/ratchetDevices.ts';
  import { PUBLIC_KEY_STORAGE_KEY } from '#src/stores/nostr/constants.ts';

  const nostr = useNostrStore();
  let owner = nostr.getLoggedInPublicKeyHex();
  let devices: MessagingDevice[] = [];
  let loadedOwner: string | null = null;
  let busy = false,
    error = '',
    mounted = false;
  let request: AbortController | undefined;
  $: if (mounted) void load(owner);

  async function load(account: string | null) {
    request?.abort();
    const current = new AbortController();
    request = current;
    devices = [];
    loadedOwner = account;
    error = '';
    busy = !!account;
    if (!account) return;
    try {
      const result = await nostr.readMessagingDevices(current.signal);
      if (request === current && !current.signal.aborted) devices = result;
    } catch {
      if (request === current && !current.signal.aborted)
        error = 'Could not load devices. Try again.';
    } finally {
      if (request === current) busy = false;
    }
  }
  onMount(() => {
    mounted = true;
    const syncOwner = (event: StorageEvent) => {
      if (!event.key || event.key === PUBLIC_KEY_STORAGE_KEY)
        owner = nostr.getLoggedInPublicKeyHex();
    };
    window.addEventListener('storage', syncOwner);
    return () => {
      request?.abort();
      window.removeEventListener('storage', syncOwner);
    };
  });
</script>

<section
  class="settings-card"
  aria-labelledby="messaging-devices-title"
  data-testid="messaging-devices"
>
  <div class="devices-heading settings-actions">
    <h3 id="messaging-devices-title">Messaging devices</h3>
    <button
      class="outline"
      disabled={busy || !owner}
      onclick={() => load(nostr.getLoggedInPublicKeyHex())}
      aria-label="Refresh messaging devices">Refresh</button
    >
  </div>
  <small>Devices authorized for double-ratchet messages.</small>
  {#if busy || loadedOwner !== owner}
    <p role="status">Loading devices…</p>
  {:else if error}
    <p class="error" role="status">{error}</p>
  {:else if devices.length}
    <ul>
      {#each devices as device (device.identityPubkey)}
        <li>
          <span>{device.isCurrent ? 'This browser' : 'Device'}</span>
          <code title={device.identityPubkey}
            >{device.identityPubkey.slice(0, 8)}…{device.identityPubkey.slice(-8)}</code
          >
        </li>
      {/each}
    </ul>
  {:else}
    <p>No messaging devices found.</p>
  {/if}
</section>

<style>
  .devices-heading {
    justify-content: space-between;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 12px;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  code {
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
</style>
