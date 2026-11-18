<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { portal } from '#src/lib/actions/portal.ts';
  import { translate } from '#src/i18n.ts';
  import type { StartupTimedSnapshot } from '#src/stores/nostr/startupState.ts';
  import Icon from './Icon.svelte';

  let { step }: { step: StartupTimedSnapshot } = $props();
  let opened = $state(false);
  let relays = $derived(step.relays ?? []);
  let counts = $derived({
    success: relays.filter((relay) => relay.status === 'success').length,
    error: relays.filter((relay) => relay.status === 'error').length,
    pending: relays.filter((relay) => relay.status === 'pending' || relay.status === 'retrying')
      .length,
  });
  let label = $derived(`${$translate('relays.relayStatus')}: ${$translate(step.label)}`);
  function showDialog(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
</script>

<button
  class="relay-status-button"
  data-testid={`startup-relay-status-${step.id}`}
  aria-label={label}
  aria-haspopup="dialog"
  title={$translate('startup.relaySummary', counts)}
  onclick={() => (opened = true)}
>
  <span class="segments" aria-hidden="true">
    {#if counts.success}<span class="green" style:flex={counts.success}></span>{/if}
    {#if counts.error}<span class="red" style:flex={counts.error}></span>{/if}
    {#if counts.pending}<span class="gray" style:flex={counts.pending}></span>{/if}
  </span>
</button>
{#if opened}
  <dialog
    use:portal
    use:showDialog
    use:dismissOnBackdrop={() => (opened = false)}
    class="relay-dialog"
    aria-label={label}
    onclose={() => (opened = false)}
  >
    <header>
      <h2>{$translate(step.label)}</h2>
      <button
        class="icon-button"
        aria-label={$translate('common.close')}
        onclick={() => (opened = false)}><Icon name="close" /></button
      >
    </header>
    <p>{$translate('startup.relaySummary', counts)}</p>
    <ul>
      {#each relays as relay (relay.relayUrl)}
        <li>
          <span
            class:green={relay.status === 'success'}
            class:red={relay.status === 'error'}
            class:gray={relay.status === 'pending' || relay.status === 'retrying'}
            class="dot"
            aria-hidden="true"
          ></span>
          <span class="relay-copy">
            <span>{relay.relayUrl}</span>
            <small
              >{$translate(`startup.relayState.${relay.status}`)}{#if relay.reason}
                · {$translate(`startup.relayReason.${relay.reason}`)}{/if}</small
            >
          </span>
        </li>
      {/each}
    </ul>
    {#if step.errorMessage && !step.errorMessage.startsWith('Relay query') && !step.errorMessage.startsWith('No requested relay')}
      <p class="error" role="alert">{$translate('startup.localFailure')}</p>
    {/if}
  </dialog>
{/if}

<style>
  .relay-status-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 24px;
    padding: 5px 0;
  }
  .relay-status-button:focus-visible {
    outline: 2px solid var(--q-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .segments {
    display: flex;
    width: 28px;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
  }
  .segments > span {
    height: 100%;
    min-width: 2px;
  }
  .green {
    background: #16a34a;
  }
  .red {
    background: #dc2626;
  }
  .gray {
    background: #64748b80;
  }
  .relay-dialog {
    width: min(460px, calc(100vw - 24px));
    max-height: calc(var(--app-viewport-height, 100dvh) - 24px);
    margin: auto;
    padding: 18px;
    border-radius: 14px;
    border: 1px solid var(--nc-border);
    color: var(--nc-text);
    background: var(--nc-panel-sidebar-bg);
    font-size: 14px;
    text-align: left;
    overflow: auto;
  }
  .relay-dialog::backdrop {
    background: #0008;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  h2 {
    font-size: 18px;
    margin: 0;
  }
  p,
  small {
    color: var(--nc-text-secondary);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 0;
  }
  .dot {
    flex: 0 0 7px;
    height: 7px;
    border-radius: 50%;
    margin-top: 7px;
  }
  .relay-copy {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
  }
  .error {
    color: var(--nc-danger);
  }
</style>
