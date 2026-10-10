<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { callRelayPrompts } from '#src/lib/platform/ui.ts';
  import { callDialogFocus } from '#src/lib/platform/callDialogFocus.ts';
  onDestroy(() => {
    for (const prompt of get(callRelayPrompts)) prompt.finish(false);
  });
</script>

{#if $callRelayPrompts[0]}
  {@const prompt = $callRelayPrompts[0]}
  <div class="backdrop" use:dismissOnBackdrop={() => prompt.finish(false)}>
    <div
      class="relay-prompt"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={prompt.title}
      use:callDialogFocus
      data-testid="call-relay-approval"
    >
      <h2>{prompt.title}</h2>
      <p>{prompt.message}</p>
      <footer>
        <button data-testid="call-relay-decline" onclick={() => prompt.finish(false)}
          >{prompt.cancelLabel}</button
        ><button class="primary" data-testid="call-relay-allow" onclick={() => prompt.finish(true)}
          >{prompt.allowLabel}</button
        >
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    z-index: 1300;
    inset: 0;
    background: #0007;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .relay-prompt {
    background: var(--nc-panel-header-bg);
    color: var(--nc-text);
    width: min(480px, calc(100vw - 32px));
    border-radius: 8px;
    padding: 24px;
    box-shadow: 0 12px 60px #0009;
  }
  .relay-prompt h2 {
    font-size: 20px;
    margin: 0 0 16px;
  }
  .relay-prompt p {
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .relay-prompt footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 20px;
  }
  .relay-prompt button {
    padding: 10px 16px;
    border-radius: 4px;
  }
</style>
