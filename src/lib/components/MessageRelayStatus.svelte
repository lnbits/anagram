<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import type { Message } from '#src/types/chat.ts';
  import { computed } from '#src/lib/state/reactivity.ts';
  import {
    useMessageBubbleStatus,
    isRetryableStatusScope,
    type StatusListItem,
  } from '#src/composables/useMessageBubbleStatus.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { locale, translate } from '#src/i18n.ts';
  import { portal } from '#src/lib/actions/portal.ts';
  import Icon from './Icon.svelte';

  export let message: Message;
  export let contactName = '';
  export let contactRelayUrls: string[] = [];
  export let publicGroup = false;
  export let onretry: ((relayUrl: string) => Promise<void>) | undefined = undefined;
  let opened = false;
  let tab = 'recipient';
  let retrying: string[] = [];
  let error = '';

  // Project the existing status model only when props change. No subscriptions,
  // relay queries or timers are needed to display recorded delivery results.
  function viewFor(
    message: Message,
    name: string,
    urls: string[],
    _locale: string,
    publicGroup: boolean,
  ) {
    const state = useMessageBubbleStatus({
      message: computed(() => message),
      isMine: computed(() => message.sender === 'me'),
      contactName: computed(() => name),
      contactRelayUrls: computed(() => urls),
    });
    return {
      visible: state.hasRelayStatuses.value,
      outbound: state.showOutboundStatus.value,
      title: state.statusDialogTitle.value,
      segments: state.statusSegments.value,
      sections:
        publicGroup && state.showOutboundStatus.value
          ? state.statusSections.value
              .filter((s) => s.key === 'recipient')
              .map((s) => ({ ...s, title: name || 'Group relays' }))
          : state.statusSections.value,
    };
  }
  $: view = viewFor(message, contactName, contactRelayUrls, $locale, publicGroup);
  $: sections = view.outbound
    ? view.sections.filter((section) => section.key === tab)
    : view.sections;
  function showDialog(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
  async function retry(items: StatusListItem[]) {
    const id = Number(message.id);
    if (!onretry && (!Number.isSafeInteger(id) || id <= 0)) return;
    error = '';
    await Promise.all(
      items.map(async (item) => {
        if (!item.retryable || !isRetryableStatusScope(item.scope) || retrying.includes(item.key))
          return;
        retrying = [...retrying, item.key];
        try {
          if (onretry) await onretry(item.relayUrl);
          else await useNostrStore().retryDirectMessageRelay(id, item.relayUrl, item.scope);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : 'Unable to retry relay delivery.';
        } finally {
          retrying = retrying.filter((key) => key !== item.key);
        }
      }),
    );
  }
</script>

{#if view.visible}
  <button
    class="relay-status-button"
    data-testid="message-relay-status"
    aria-label={view.title}
    title={view.title}
    aria-haspopup="dialog"
    aria-expanded={opened}
    onclick={(event) => {
      event.stopPropagation();
      opened = true;
      error = '';
    }}
  >
    <span class="segments" aria-hidden="true">
      {#each view.segments as segment (segment.key)}
        <span class={segment.className} style:flex={`${segment.weight} 1 0`}></span>
      {/each}
    </span>
  </button>
{/if}
{#if opened}
  <dialog
    use:portal
    use:showDialog
    class="relay-dialog"
    aria-label={view.title}
    onclose={() => (opened = false)}
    use:dismissOnBackdrop={() => (opened = false)}
  >
    <header>
      <h2>{view.title}</h2>
      <button class="icon-button" aria-label="Close relay details" onclick={() => (opened = false)}
        ><Icon name="close" /></button
      >
    </header>
    {#if view.outbound && view.sections.length > 1}
      <div class="tabs" role="tablist" aria-label={view.title}>
        {#each view.sections as section}
          <button
            role="tab"
            aria-selected={tab === section.key}
            data-testid={`relay-status-tab-${section.key}`}
            onclick={() => (tab = section.key)}>{section.tabLabel}</button
          >
        {/each}
      </div>
    {/if}
    {#each sections as section (section.key)}
      <section data-testid={`relay-status-panel-${section.key}`} aria-label={section.title}>
        {#if !view.outbound || view.sections.length === 1}<h3>{section.title}</h3>{/if}
        <ul>
          {#each section.items as item (item.key)}
            <li>
              <span class={`dot ${item.dotClass}`} aria-hidden="true"></span>
              <span class="relay-copy"
                ><span>{item.relayUrl}</span><small
                  >{item.status}{#if item.detail}
                    · {item.detail}{/if}</small
                ></span
              >
              {#if item.retryable && isRetryableStatusScope(item.scope)}
                <button
                  class="link"
                  disabled={retrying.includes(item.key)}
                  onclick={() => retry([item])}>{$translate('common.retry')}</button
                >
              {/if}
            </li>
          {:else}<li>{section.emptyLabel}</li>{/each}
        </ul>
        {#if section.items.some((item) => item.retryable && isRetryableStatusScope(item.scope))}
          <button
            class="link retry-all"
            data-testid="relay-status-retry-all-button"
            disabled={retrying.length > 0}
            onclick={() => retry(section.items)}>{$translate('relays.retryFailed')}</button
          >
        {/if}
      </section>
    {/each}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </dialog>
{/if}

<style>
  .relay-status-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
    min-width: 28px;
    min-height: 20px;
    padding: 5px 0;
    margin-left: 5px;
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
    min-width: 4px;
  }
  .segments :global(.bubble__status-segment--green),
  .dot:global(.bubble__status-list-dot--green) {
    background: #16a34a;
  }
  .segments :global(.bubble__status-segment--blue),
  .dot:global(.bubble__status-list-dot--blue) {
    background: #2563eb;
  }
  .segments :global(.bubble__status-segment--red),
  .dot:global(.bubble__status-list-dot--red) {
    background: #dc2626;
  }
  .segments :global(.bubble__status-segment--gray),
  .dot:global(.bubble__status-list-dot--gray) {
    background: #64748b80;
  }
  .relay-dialog {
    width: min(460px, calc(100vw - 24px));
    max-height: calc(100dvh - 24px);
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
  h3 {
    font-size: 13px;
    margin: 12px 0 8px;
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--nc-border);
    margin-bottom: 12px;
  }
  .tabs button {
    flex: 1;
    padding: 10px 6px;
    border-bottom: 2px solid transparent;
  }
  .tabs button[aria-selected='true'] {
    color: var(--q-primary);
    border-bottom-color: var(--q-primary);
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
    color: var(--nc-text-secondary);
  }
  .retry-all {
    display: block;
    margin: 12px 0 0 auto;
  }
</style>
