<script lang="ts">
  import type { MessageReplyPreview } from '#src/types/chat.ts';
  import ProfileName from './ProfileName.svelte';
  import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
  export let reply: MessageReplyPreview;
  export let onclick: () => void;
  $: preview = buildMessageReplyPreviewContent(reply.text, undefined).text;
</script>

<button class="reply-preview" {onclick}>
  {#if reply.authorPublicKey && reply.sender !== 'me'}<ProfileName
      publicKey={reply.authorPublicKey}
      fallback={reply.authorName}
    />{:else}{reply.authorName}{/if}{reply.authorName ? ': ' : ''}<span
    class="reply-preview-content">{preview}</span
  >
</button>
