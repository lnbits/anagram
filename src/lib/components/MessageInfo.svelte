<script lang="ts">
  import type { Message, MessageRelayStatus } from '#src/types/chat.ts';
  import { translate } from '#src/i18n.ts';
  import { Notify } from '#src/lib/platform/ui.ts';
  export let message: Message;
  export let onretry: (status: MessageRelayStatus) => Promise<void>;
  let error = '';
  let busy = false;
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await fn();
    } catch (cause) {
      error = String(cause);
    } finally {
      busy = false;
    }
  }
  async function copyEventId() {
    try {
      await navigator.clipboard.writeText(message.eventId ?? '');
      Notify.create({
        message: $translate('common.copiedLabel', { label: $translate('message.eventId') }),
      });
    } catch {
      Notify.create({ type: 'negative', message: 'Could not copy the event ID.' });
    }
  }
</script>

<dl class="message-info">
  <dt>{$translate('common.sent')}</dt>
  <dd>{new Date(message.sentAt).toLocaleString()}</dd>
  <dt>{$translate('contacts.authorPubkey')}</dt>
  <dd>{message.authorPublicKey}</dd>
  <dt>{$translate('message.eventId')}</dt>
  <dd>{message.eventId || 'Not published yet'}</dd>
</dl>
<button class="outline" disabled={!message.eventId} onclick={copyEventId}>Copy event ID</button>
{#each message.nostrEvent?.relay_statuses ?? [] as status}<p>
    {status.relay_url} — {status.status}
    {#if message.sender === 'me' && status.status === 'failed' && (status.scope === 'recipient' || status.scope === 'self')}<button
        class="outline"
        disabled={busy}
        onclick={() => act(() => onretry(status))}>Retry</button
      >{/if}
  </p>{/each}
{#if message.nostrEvent?.event}<details>
    <summary>Event JSON</summary>
    <pre class="event-json">{JSON.stringify(message.nostrEvent.event, null, 2)}</pre>
  </details>{/if}
{#if error}<p role="alert" class="error">{error}</p>{/if}
