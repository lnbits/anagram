<script lang="ts">
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { onDestroy } from 'svelte';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  export let hydrate = false;
  let release = () => {};
  function hydrateProfile(key: string, enabled: boolean) {
    release();
    release = enabled ? useNostrStore().retainVisibleProfileTarget(key) : () => {};
  }
  $: hydrateProfile(publicKey, hydrate);
  onDestroy(() => release());
  export let publicKey: string;
  export let fallback = '';
  export let givenName = '';
  $: profile = observePublicProfile(publicKey);
</script>

{givenName || $profile?.name || fallback}
