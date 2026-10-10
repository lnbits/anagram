<script lang="ts">
  import ImageUrlField from './ImageUrlField.svelte';
  export let name: string | undefined = '';
  export let about: string | undefined = '';
  export let picture: string | undefined = '';
  export let uploading = false;
  export let showPicture = true;
  export let disabled = false;
  export let contextKey: string;
  export let nameLimit: number | undefined = undefined;
  export let aboutLimit: number | undefined = undefined;
</script>

<label>Group name<input bind:value={name} maxlength={nameLimit} {disabled} /></label>
<label
  >Description<textarea bind:value={about} maxlength={aboutLimit} rows="3" {disabled}
  ></textarea></label
>
{#if showPicture}<ImageUrlField bind:value={picture} bind:uploading {disabled} {contextKey} />{/if}
