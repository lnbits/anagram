<script lang="ts">
  import type { MessageReplyPreview } from '#src/types/chat.ts';
  import Icon from './Icon.svelte';
  import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
  export let editing = false;
  export let reply: MessageReplyPreview | null = null;
  export let oncancel: () => void;
  $: preview = reply ? buildMessageReplyPreviewContent(reply.text, undefined).text : '';
</script>

{#if reply || editing}<div class="composer-context">
    <span class="composer-context-content"
      >{editing ? 'Editing message' : `Reply to ${reply?.authorName}: ${preview}`}</span
    ><button aria-label="Cancel reply or edit" onclick={oncancel}><Icon name="close" /></button>
  </div>{/if}
