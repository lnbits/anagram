<script lang="ts">
  import { onMount } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import {
    defaultIrohRelays,
    normalizeIrohRelayUrl,
    isSharedIrohRelay,
    type IrohRelaySettings,
    type IrohRelayMode,
  } from '#src/utils/irohRelays.ts';
  import Icon from '../Icon.svelte';
  const nostr = useNostrStore(),
    restoring = observe(() => nostr.isRestoringStartupState);
  let settings = nostr.getIrohRelaySettings(),
    input = '',
    busy = false,
    error = '';
  const modes: IrohRelayMode[] = ['pool', 'pool-custom', 'custom'];
  $: if (!$restoring && !busy) settings = nostr.getIrohRelaySettings();
  $: rows = [
    ...(settings.mode === 'custom'
      ? []
      : defaultIrohRelays().map((url) => ({ url, shared: true }))),
    ...settings.customRelays.map((url) => ({ url, shared: false })),
  ];
  async function save(next: IrohRelaySettings) {
    if (busy || $restoring) return;
    busy = true;
    error = '';
    try {
      await nostr.saveIrohRelaySettings(next);
      settings = nostr.getIrohRelaySettings();
      input = '';
    } catch {
      error = $translate('iroh.saveFailed');
    } finally {
      busy = false;
    }
  }
  $: validInput = normalizeIrohRelayUrl(input);
  $: canAdd =
    !!validInput &&
    !isSharedIrohRelay(validInput) &&
    !settings.customRelays.includes(validInput) &&
    settings.customRelays.length < 16;
  function add() {
    const url = normalizeIrohRelayUrl(input);
    if (!url) {
      error = $translate('iroh.invalidUrl');
      return;
    }
    if (isSharedIrohRelay(url)) {
      error = $translate('iroh.builtInRelay');
      return;
    }
    if (settings.customRelays.includes(url)) {
      error = $translate('iroh.duplicate');
      return;
    }
    if (settings.customRelays.length >= 16) {
      error = $translate('iroh.limit');
      return;
    }
    void save({
      mode: settings.mode === 'pool' ? 'pool-custom' : settings.mode,
      customRelays: [...settings.customRelays, url],
    });
  }
  function remove(url: string) {
    const customRelays = settings.customRelays.filter((r) => r !== url);
    void save({ mode: customRelays.length ? settings.mode : 'pool', customRelays });
  }
  onMount(() => {
    const sync = () => {
      if (!busy) settings = nostr.getIrohRelaySettings();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  });
</script>

<div
  class="iroh-settings"
  role="tabpanel"
  id="settings-relay-panel-iroh"
  aria-labelledby="settings-relay-tab-iroh"
  data-testid="settings-iroh-panel"
>
  <div class="iroh-modes" role="radiogroup" aria-label={$translate('iroh.mode')}>
    {#each modes as mode}<label class="settings-switch"
        ><input
          type="radio"
          name="iroh-mode"
          data-testid={`iroh-mode-${mode}`}
          checked={settings.mode === mode}
          disabled={busy || $restoring || (mode !== 'pool' && !settings.customRelays.length)}
          onchange={() => save({ ...settings, mode })}
        />{$translate(`iroh.mode.${mode}`)}</label
      >{/each}
  </div>
  <form
    class="relay-toolbar"
    onsubmit={(e) => {
      e.preventDefault();
      add();
    }}
  >
    <div class="relay-add-field">
      <label class="settings-field"
        ><span>{$translate('relays.relayUrl')}</span><input
          data-testid="iroh-new-relay"
          bind:value={input}
          placeholder="https://relay.example.com"
          disabled={busy || $restoring}
        /></label
      ><button
        class="relay-add-button"
        aria-label={$translate('relays.addRelay')}
        data-testid="iroh-add-relay"
        disabled={busy || $restoring || !canAdd}><Icon name="add" /></button
      >
    </div>
    <button
      type="button"
      class="link relay-defaults"
      data-testid="iroh-default-relays"
      disabled={busy || $restoring || (settings.mode === 'pool' && !settings.customRelays.length)}
      onclick={() => save({ mode: 'pool', customRelays: [] })}
      ><Icon name="refresh" />{$translate('relays.useDefaultRelays')}</button
    >
  </form>
  <p class="settings-caption iroh-hint">{$translate('iroh.explanation')}</p>
  {#if busy}<p role="status">{$translate('iroh.saving')}</p>{/if}{#if error}<p
      role="alert"
      class="error"
    >
      {error}
    </p>{/if}
  <div class="settings-relay-list">
    <div class="iroh-relays">
      {#each rows as row (row.url)}<div class="iroh-relay" data-testid="iroh-relay-row">
          <span class="relay-avatar"><Icon name="satellite_alt" /></span><span class="relay-url"
            >{row.url}<br /><small
              >{$translate(
                row.shared
                  ? 'iroh.sharedPool'
                  : settings.mode === 'pool'
                    ? 'iroh.customInactive'
                    : 'iroh.customRelay',
              )}</small
            ></span
          >{#if !row.shared}<button
              class="icon-button relay-delete"
              aria-label={$translate('relays.deleteRelay')}
              disabled={busy ||
                $restoring ||
                (settings.mode === 'custom' && settings.customRelays.length === 1)}
              onclick={() => remove(row.url)}><Icon name="delete" /></button
            >{/if}
        </div>{/each}
    </div>
  </div>
  <p class="settings-caption iroh-hint">{$translate('iroh.nextCalls')}</p>
</div>
