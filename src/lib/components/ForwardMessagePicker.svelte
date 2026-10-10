<script lang="ts">
  import Avatar from './Avatar.svelte';
  export let destinations: {
    id: string;
    name: string;
    publicKey: string;
    kind: 'user' | 'group' | 'public';
  }[];
  export let onselect: (id: string, publicGroup: boolean) => void;
</script>

{#each destinations as destination}<button
    class="settings-item"
    data-testid="forward-destination"
    data-kind={destination.kind}
    data-public-key={destination.publicKey}
    onclick={() => onselect(destination.id, destination.kind === 'public')}
  >
    <Avatar
      privateGroup={destination.kind === 'group'}
      publicGroup={destination.kind === 'public'}
      name={destination.name}
      publicKey={destination.publicKey}
      size={36}
    />
    <span
      >{destination.name}{#if destination.kind === 'public'}<small>
          · Public group</small
        >{/if}</span
    >
  </button>{/each}
