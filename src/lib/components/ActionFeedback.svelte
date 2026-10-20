<script lang="ts">
  import { actionFeedback } from '#src/lib/platform/ui.ts';
  import Icon from './Icon.svelte';
</script>

{#if $actionFeedback}
  <div class="action-feedback" data-testid="action-feedback">
    <p role="alert" class:error={$actionFeedback.type === 'negative'}>{$actionFeedback.message}</p>
    <button
      class="icon-button"
      aria-label="Dismiss message"
      onclick={() => actionFeedback.set(null)}><Icon name="close" /></button
    >
  </div>
{/if}

<style>
  .action-feedback {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    padding: 8px 16px;
    border-bottom: 1px solid var(--nc-border);
    overflow-wrap: anywhere;
  }
  p {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
</style>
