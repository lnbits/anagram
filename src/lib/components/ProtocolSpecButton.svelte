<script lang="ts">
  import directMessages from '../../../docs/direct-messages.md?raw';
  import privateGroups from '../../../docs/private-groups.md?raw';
  import publicGroups from '../../../docs/public-groups.md?raw';
  import ModalFrame from './ModalFrame.svelte';
  import SimpleMarkdown from './SimpleMarkdown.svelte';

  export let kind: 'direct' | 'private' | 'public';
  const specs = { direct: directMessages, private: privateGroups, public: publicGroups };
  let open = false;
  $: markdown = specs[kind];
  $: title = markdown.split('\n', 1)[0].replace(/^# /, '') + ' spec';
  $: body = markdown.slice(markdown.indexOf('\n') + 1);
</script>

<button type="button" class="outline" onclick={() => (open = true)}>Spec</button>
{#if open}
  <ModalFrame {title} closeLabel="Close spec" onclose={() => (open = false)}>
    <SimpleMarkdown markdown={body} />
  </ModalFrame>
{/if}
