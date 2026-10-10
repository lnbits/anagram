<script lang="ts">
  import { onMount } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useRelayStore } from '#src/stores/relayStore.ts';
  import { useNip65RelayStore } from '#src/stores/nip65RelayStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { normalizeRelayUrl } from '#src/lib/nostr/client.ts';
  import { DEFAULT_RELAYS } from '#src/constants/relays.ts';
  import type { RelayListEntry } from '#src/stores/relayListStoreFactory.ts';
  import RelayInfo from './RelayInfo.svelte';
  import Icon from '../Icon.svelte';
  import IrohSettings from './IrohSettings.svelte';
  const nostr = useNostrStore(),
    app = useRelayStore(),
    mine = useNip65RelayStore();
  app.init();
  mine.init();
  const state = observe(() => ({
    mine: mine.relayEntries,
    app: app.relayEntries,
    version: nostr.relayStatusVersion,
  }));
  let tab = 'my',
    input = '',
    error = '',
    syncError = '',
    syncing = false;
  function selectTab(id: string) {
    tab = id;
    input = '';
    error = '';
  }
  function tabKey(event: KeyboardEvent, id: string) {
    const ids = ['my', 'app', 'iroh'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? 2
          : (ids.indexOf(id) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    selectTab(ids[next]);
    const parent = (event.currentTarget as HTMLElement).parentElement;
    parent?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  let expanded = new Set<string>();
  function toggleInfo(url: string) {
    if (expanded.has(url)) expanded = new Set([...expanded].filter((entry) => entry !== url));
    else {
      expanded = new Set([...expanded, url]);
      void info(url);
    }
  }
  let pending: RelayListEntry[] | null = null;
  let infos: Record<string, unknown> = {},
    loading: Record<string, boolean> = {};
  $: entries = tab === 'my' ? $state.mine : $state.app;
  $: store = tab === 'my' ? mine : app;
  async function sync() {
    pending = mine.relayEntries.map((r) => ({ ...r }));
    if (syncing) return;
    syncing = true;
    syncError = '';
    try {
      while (pending) {
        const snapshot = pending;
        pending = null;
        await nostr.publishMyRelayList(snapshot, app.relays);
        await nostr.updateLoggedInUserRelayList(snapshot);
      }
    } catch {
      syncError = 'Your relay changes could not be published. Retry to sync them to your account.';
    } finally {
      syncing = false;
    }
  }
  function changed() {
    if (tab === 'my') void sync();
  }
  function add() {
    error = '';
    try {
      const parsed = new URL(input.trim());
      if (
        !['wss:', 'ws:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error();
      const url = normalizeRelayUrl(input.trim());
      if (entries.some((r) => normalizeRelayUrl(r.url) === url)) {
        error = $translate('relays.validation.alreadyAdded');
        return;
      }
      store.addRelay(url);
      input = '';
      changed();
    } catch {
      error = $translate('relays.relayMustValidWs');
    }
  }
  function restore() {
    store.restoreDefaults();
    if (tab === 'my') {
      for (const url of DEFAULT_RELAYS) mine.addRelay(url);
      void sync();
    }
  }
  async function info(url: string, force = false) {
    if (loading[url] || (!force && infos[url])) return;
    loading = { ...loading, [url]: true };
    try {
      infos = {
        ...infos,
        [url]: (await nostr.fetchRelayNip11Info(url, force)) ?? 'No NIP-11 information available.',
      };
    } catch {
      infos = { ...infos, [url]: 'Could not load NIP-11 information.' };
    } finally {
      loading = { ...loading, [url]: false };
    }
  }
  onMount(() => {
    void nostr.ensureRelayConnections([...mine.relays, ...app.relays]).catch(() => {});
  });
</script>

<div class="settings-tabs" role="tablist" aria-label={$translate('relays.title')}>
  {#each [['my', 'relays.nip65.mineTitle'], ['app', 'relays.appRelays.title'], ['iroh', 'iroh.title']] as [id, label]}<button
      role="tab"
      id={`settings-relay-tab-${id}`}
      aria-controls={`settings-relay-panel-${id}`}
      tabindex={tab === id ? 0 : -1}
      onkeydown={(event) => tabKey(event, id)}
      aria-selected={tab === id}
      data-testid={`settings-relays-${id}-tab`}
      onclick={() => selectTab(id)}>{$translate(label)}</button
    >{/each}
</div>
{#if tab === 'iroh'}<IrohSettings />{:else}
  <div class="relay-settings-panel" role="tabpanel" data-testid={`settings-relays-${tab}-panel`}>
    <form
      class="relay-toolbar"
      onsubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <div class="relay-add-field">
        <label class="settings-field">
          <span>{$translate('relays.relayUrl')}</span>
          <input
            data-testid="relay-editor-new-relay-input"
            bind:value={input}
            placeholder="wss://example-relay.io"
            spellcheck="false"
            autocapitalize="none"
          />
        </label>
        <button
          class="relay-add-button"
          data-testid="relay-editor-add-relay-button"
          aria-label={$translate('relays.addRelay')}
          disabled={!input.trim()}><Icon name="add" /></button
        >
      </div>
      <button type="button" class="link relay-defaults" onclick={restore}
        ><Icon name="refresh" />{$translate(
          tab === 'my' ? 'relays.useDefaultRelays' : 'relays.restoreDefaultRelays',
        )}</button
      >
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if tab === 'my' && syncing}<p class="settings-caption" role="status">
        {$translate('common.progress')}
      </p>{/if}
    {#if syncError}<p class="error" role="alert">{syncError}</p>
      <button class="outline" onclick={sync} disabled={syncing}>{$translate('common.retry')}</button
      >{/if}
    <div class="settings-relay-list">
      {#each entries as relay, index (relay.url)}
        <div class="relay-entry">
          <div class="relay-entry-header">
            <button
              class="icon-button relay-expand"
              aria-label={`${$translate('relays.expandLoadNip11Data')}: ${relay.url}`}
              aria-expanded={expanded.has(relay.url)}
              aria-controls={`relay-info-${tab}-${index}`}
              onclick={() => toggleInfo(relay.url)}
              ><span class:expanded={expanded.has(relay.url)} aria-hidden="true">›</span></button
            >
            <div class="relay-badges">
              <span class="relay-avatar"><Icon name="satellite_alt" /></span><span
                class="connection-dot"
                role="img"
                aria-label={$state.version >= 0 &&
                nostr.getRelayConnectionState(relay.url) === 'connected'
                  ? $translate('common.connected')
                  : 'Disconnected'}
                class:connected={$state.version >= 0 &&
                  nostr.getRelayConnectionState(relay.url) === 'connected'}
              ></span>
            </div>
            <div class="relay-identity">
              <button
                type="button"
                class="relay-url"
                title={relay.url}
                aria-expanded={expanded.has(relay.url)}
                aria-controls={`relay-info-${tab}-${index}`}
                onclick={() => toggleInfo(relay.url)}>{relay.url}</button
              >
              <div class="relay-io">
                <label class="settings-switch"
                  ><input
                    type="checkbox"
                    role="switch"
                    checked={relay.read}
                    onchange={(e) => {
                      store.setRelayFlags(index, { read: e.currentTarget.checked });
                      changed();
                    }}
                  />{$translate('relays.read')}</label
                >
                <label class="settings-switch"
                  >{$translate('common.write')}<input
                    type="checkbox"
                    role="switch"
                    checked={relay.write}
                    onchange={(e) => {
                      store.setRelayFlags(index, { write: e.currentTarget.checked });
                      changed();
                    }}
                  /></label
                >
              </div>
            </div>
            <button
              class="icon-button relay-delete"
              aria-label={$translate('relays.deleteRelay')}
              data-testid="relay-editor-delete-relay-button"
              onclick={() => {
                store.removeRelay(index);
                changed();
              }}><Icon name="delete" /></button
            >
          </div>
          <div
            id={`relay-info-${tab}-${index}`}
            class="relay-info"
            hidden={!expanded.has(relay.url)}
          >
            {#if expanded.has(relay.url)}
              {#if loading[relay.url]}<p>{$translate('relays.loadingNip11Data')}</p>
              {:else}
                {#if typeof infos[relay.url] === 'string'}<p>
                    {String(infos[relay.url])}
                  </p>{:else}<RelayInfo value={infos[relay.url]} />{/if}
                <button class="link" onclick={() => info(relay.url, true)}
                  >{$translate('common.refresh')}</button
                >
              {/if}
            {/if}
          </div>
        </div>
      {:else}<p class="settings-caption">
          {$translate(tab === 'my' ? 'relays.nip65RelaysConfigured' : 'relays.appRelaysConfigured')}
        </p>{/each}
    </div>
  </div>
{/if}
