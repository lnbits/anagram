<script lang="ts">
  import Avatar from '../Avatar.svelte';
  export let name: string;
  export let picture = '';
  export let size = 44;
</script>

<Avatar {name} {picture} {size} publicGroup />
