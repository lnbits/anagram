<script lang="ts">
  import type { Snippet } from 'svelte';
  import Avatar from './Avatar.svelte';
  import ProfileName from './ProfileName.svelte';
  export let publicKey: string;
  export let npub: string;
  export let name = '';
  export let givenName = '';
  export let picture = '';
  export let allowAvatar = true;
  export let onopen: (() => void) | undefined = undefined;
  export let children: Snippet;
</script>

<div class="member" data-public-key={publicKey}>
  <Avatar
    publicKey={allowAvatar ? publicKey : ''}
    name={name || publicKey.slice(0, 12)}
    picture={allowAvatar ? picture : ''}
    size={36}
  />
  <div class="member-info">
    {#if onopen}<button class="member-profile" onclick={onopen}
        ><ProfileName {publicKey} {givenName} fallback={name || publicKey.slice(0, 16)} /></button
      >
    {:else}<ProfileName {publicKey} {givenName} fallback={name || publicKey.slice(0, 16)} />{/if}
    <small>{npub}</small>
    {@render children()}
  </div>
</div>

<style>
  .member {
    display: flex;
    align-items: start;
    gap: 10px;
    padding: 12px 0;
  }
  .member-info {
    min-width: 0;
    flex: 1;
  }
  small {
    display: block;
    overflow-wrap: anywhere;
    opacity: 0.75;
    margin: 4px 0;
  }
</style>
