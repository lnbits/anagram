<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { onMount } from 'svelte';
  import { observe } from '#src/lib/state/store.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useRelayStore } from '#src/stores/relayStore.ts';
  import { translate } from '#src/i18n.ts';
  import {
    getBrowserNotificationPermission,
    requestBrowserNotificationsAfterLogin,
    saveBrowserNotificationsPreference,
  } from '#src/utils/browserNotificationPreference.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  export let oncomplete: () => void;
  export let onlogout: () => void;
  export let title = 'profile.checkingProfile';
  export let subtitle = 'relays.stayHereAppChecks';
  const nostr = useNostrStore(),
    relays = useRelayStore();
  const relayStatus = observe(() => {
    void nostr.relayStatusVersion;
    return Object.fromEntries(
      relays.relays.map((url) => [url, nostr.getRelayConnectionState(url)]),
    );
  });
  let status: 'checking' | 'found' | 'not-found' | 'error' | 'relays' | 'profile' = 'relays';
  let profile: Awaited<ReturnType<typeof nostr.fetchUserProfileFromRelays>> = null;
  let entries: Array<{ url: string; selected: boolean }> = [];
  let relayInput = '',
    error = '',
    name = '',
    about = '';
  export let busy = false;
  export let canGoBack = false;
  $: canGoBack = status === 'profile';
  export function backToRelays() {
    if (!busy) status = 'relays';
  }
  let publishRelays = true,
    notifications = false;
  let lookupGeneration = 0,
    mounted = true;
  let checking = new Set<string>();
  $: title =
    status === 'found'
      ? 'profile.confirmProfile'
      : status === 'relays'
        ? 'relays.appRelays.label'
        : status === 'profile'
          ? 'profile.setUpProfile'
          : status === 'error'
            ? 'profile.profileCheckFailed'
            : 'profile.checkingProfile';
  $: subtitle =
    status === 'found'
      ? 'relays.profileFoundAppRelays'
      : status === 'relays'
        ? 'relays.addRemoveRelaysSearching'
        : status === 'profile'
          ? 'common.finalStepEnteringApp'
          : status === 'not-found'
            ? 'relays.youAddRelaysSkip'
            : status === 'error'
              ? 'relays.appCouldFinishChecking'
              : 'relays.stayHereAppChecks';
  onMount(() => {
    relays.init();
    entries = relays.relays.map((url) => ({ url, selected: false }));
    for (const entry of entries) void probeRelay(entry.url);
    return () => {
      mounted = false;
      lookupGeneration++;
    };
  });
  async function probeRelay(url: string) {
    checking = new Set([...checking, url]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        nostr.ensureRelayConnections([url]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 10000);
        }),
      ]);
    } catch {
      /* The relay row shows connection failure and can be retried or removed. */
    } finally {
      clearTimeout(timer);
      if (mounted) {
        entries = entries.map((entry) =>
          entry.url === url
            ? { ...entry, selected: nostr.getRelayConnectionState(url) === 'connected' }
            : entry,
        );
        checking = new Set([...checking].filter((value) => value !== url));
      }
    }
  }
  async function lookup(setup = false) {
    const generation = ++lookupGeneration;
    status = 'checking';
    error = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      profile = await Promise.race([
        nostr.fetchUserProfileFromRelays(
          nostr.getLoggedInPublicKeyHex() ?? '',
          entries.filter((e) => e.selected).map((e) => e.url),
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Profile lookup timed out.')), 10000);
        }),
      ]);
      if (generation !== lookupGeneration) return;
      status = profile ? 'found' : setup ? 'profile' : 'not-found';
    } catch {
      if (generation === lookupGeneration) {
        status = 'error';
        error = 'Profile lookup failed. You can retry, edit relays, or continue.';
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  function addRelay() {
    try {
      const url = new URL(relayInput.trim());
      if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password)
        throw new Error();
      if (entries.some((e) => new URL(e.url).href === url.href)) {
        error = 'Relay already added.';
        return;
      }
      entries = [{ url: url.href, selected: false }, ...entries];
      relays.replaceRelayEntries(
        entries.map((entry) => ({ url: entry.url, read: true, write: true })),
      );
      void probeRelay(url.href);
      relayInput = '';
      error = '';
    } catch {
      error = 'Enter a valid ws:// or wss:// relay URL.';
    }
  }
  async function finish(createProfile = false) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const selected = entries
        .filter((e) => e.selected)
        .map((e) => ({ url: e.url, read: true, write: true }));
      if (createProfile) {
        if (name.trim() || about.trim())
          await nostr.publishUserMetadata(
            { name: name.trim(), about: about.trim() },
            selected.map((e) => e.url),
          );
        if (publishRelays && selected.length) await nostr.updateLoggedInUserRelayList(selected);
      }
      if (selected.length) relays.replaceRelayEntries(selected);
      const permission = getBrowserNotificationPermission();
      if (permission === 'default' || permission === 'native') notifications = true;
      else {
        saveBrowserNotificationsPreference(permission === 'granted');
        complete();
      }
    } catch {
      error = 'Unable to finish setup. Please try again.';
    } finally {
      busy = false;
    }
  }
  function complete() {
    localStorage.removeItem('anagram-onboarding-pending');
    oncomplete();
  }
  async function notify(enable: boolean) {
    if (enable) await requestBrowserNotificationsAfterLogin();
    else saveBrowserNotificationsPreference(false);
    complete();
  }
  async function logout() {
    if (busy) return;
    busy = true;
    try {
      await nostr.logout();
      localStorage.removeItem('anagram-onboarding-pending');
      onlogout();
    } catch {
      error = 'Unable to log out. Please try again.';
    } finally {
      busy = false;
    }
  }
</script>

<div class="onboarding">
  {#if status === 'checking'}
    <div class="checking" role="status">
      <span class="spinner"></span>
      <div>
        <strong>{$translate('profile.lookingProfile')}</strong>
        <p>{$translate('profile.checkingNostrMetadata', { count: entries.length })}</p>
      </div>
    </div>
  {:else if status === 'found' && profile}
    <div class="profile">
      <Avatar name={profile.name} picture={profile.picture} size={72} />
      <div>
        <strong>{profile.name}</strong><small>{nostr.encodeNpub(profile.publicKey)}</small>
        <p>{profile.about}</p>
        {#if profile.nip05}<small>{profile.nip05}</small>{/if}
      </div>
    </div>
  {:else if status === 'not-found'}<p class="banner">
      {$translate('relays.profileFoundCurrentApp')}
    </p>
  {:else if status === 'relays'}
    <form
      class="relay-form"
      onsubmit={(e) => {
        e.preventDefault();
        addRelay();
      }}
    >
      <label
        >{$translate('relays.relayUrl')}<input
          bind:value={relayInput}
          placeholder="wss://example-relay.io"
          data-testid="auth-onboarding-relay-input"
        /></label
      ><button
        class="primary"
        aria-label="Add relay"
        disabled={!relayInput.trim()}
        data-testid="auth-onboarding-add-relay-button"><Icon name="add" /></button
      >
    </form>
    <div class="relay-list">
      {#each entries as entry}<div class="relay">
          <label
            >{#if checking.has(entry.url)}<span
                class="relay-spinner"
                aria-label={`Checking ${entry.url}`}
              ></span>{:else}<input
                type="checkbox"
                bind:checked={entry.selected}
                aria-label={`Use ${entry.url} for profile lookup`}
              />{/if}<span
              class="relay-status"
              class:connected={$relayStatus[entry.url] === 'connected'}
              aria-label={$relayStatus[entry.url] === 'connected' ? 'Connected' : 'Disconnected'}
              ><Icon name={$relayStatus[entry.url] === 'connected' ? 'check' : 'warning'} /></span
            >{entry.url}</label
          ><button
            class="icon-button"
            aria-label={`Delete ${entry.url}`}
            onclick={() => (entries = entries.filter((e) => e !== entry))}
            ><Icon name="delete" /></button
          >
        </div>{/each}
    </div>
  {:else if status === 'profile'}
    <label
      >{$translate('common.nameOptional')}<input
        bind:value={name}
        data-testid="auth-onboarding-profile-name-input"
      /></label
    >
    <label
      >{$translate('common.aboutOptional')}<textarea
        bind:value={about}
        data-testid="auth-onboarding-profile-about-input"></textarea></label
    >
    <label class="check"
      ><input
        type="checkbox"
        bind:checked={publishRelays}
        data-testid="auth-onboarding-update-relays-checkbox"
      />{$translate('relays.useSelectedRelaysProfile')}</label
    >
  {/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if status === 'found'}<div class="button-row">
      <button
        class="outline"
        onclick={logout}
        disabled={busy}
        data-testid="auth-onboarding-logout-button"
        ><Icon name="logout" />{$translate('settings.logout')}</button
      ><button
        class="primary"
        onclick={() => finish()}
        disabled={busy}
        data-testid="auth-onboarding-continue-button"
        >{#if busy}<span class="save-spinner" aria-label="Connecting"></span>{:else}{$translate(
            'common.confirmStartUsingApp',
          )}{/if}</button
      >
    </div>
  {:else if status === 'not-found'}<div class="button-row">
      <button
        class="outline"
        onclick={() => finish()}
        disabled={busy}
        data-testid="auth-onboarding-skip-button">{$translate('common.skipNow')}</button
      ><button
        class="primary"
        onclick={() => (status = 'relays')}
        data-testid="auth-onboarding-add-relays-button">{$translate('relays.addRelays')}</button
      >
    </div>
  {:else if status === 'error'}<button
      class="primary"
      onclick={() => lookup()}
      data-testid="auth-onboarding-retry-button">{$translate('common.tryAgain')}</button
    >
    <div class="button-row">
      <button class="outline" onclick={() => (status = 'relays')}
        >{$translate('relays.editRelays')}</button
      ><button class="outline" onclick={() => finish()} data-testid="auth-onboarding-skip-button"
        >{$translate('common.continue')}</button
      >
    </div>
  {:else if status === 'relays'}<div class="button-row">
      <button
        class="outline"
        onclick={logout}
        disabled={busy}
        data-testid="auth-onboarding-logout-button"
        ><Icon name="logout" />{$translate('settings.logout')}</button
      ><button
        class="primary"
        disabled={!entries.some((e) => e.selected)}
        onclick={() => {
          entries = entries.filter((entry) => entry.selected);
          void lookup(true);
        }}
        data-testid="auth-onboarding-relays-next-button">{$translate('common.next')}</button
      >
    </div>
  {:else if status === 'profile'}<button
      class="primary"
      disabled={busy}
      onclick={() => finish(true)}
      data-testid="auth-onboarding-profile-start-button"
      >{#if busy}<span class="save-spinner" aria-label="Saving"></span>{:else}{$translate(
          'common.saveStartUsingApp',
        )}{/if}</button
    >{/if}
</div>
{#if notifications}<div class="modal-backdrop" use:dismissOnBackdrop={() => void notify(false)}>
    <div
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      class="modal notification-dialog"
      aria-label={$translate('notifications.enableBrowserNotifications')}
    >
      <h2>{$translate('notifications.enableBrowserNotifications')}</h2>
      <p>{$translate('notifications.browser.enablePrompt')}</p>
      <p>{$translate('notifications.manageLaterHint')}</p>
      <div class="button-row">
        <button class="outline" onclick={() => notify(false)} data-testid="auth-notifications-skip"
          >{$translate('common.now')}</button
        ><button class="primary" onclick={() => notify(true)}>{$translate('common.enable')}</button>
      </div>
    </div>
  </div>{/if}

<style>
  .relay-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #cbd5e1;
    border-top-color: var(--q-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  .relay-status {
    display: inline-flex;
    color: var(--q-warning, #d97706);
  }
  .relay-status.connected {
    color: var(--q-positive, #059669);
  }
  .onboarding {
    display: grid;
    gap: 16px;
    padding-top: 6px;
  }
  .checking,
  .profile {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 6px 0;
  }
  .checking {
    min-height: 116px;
  }
  .checking strong {
    font-size: 18px;
  }
  .profile > div {
    min-width: 0;
  }
  .profile strong {
    font-size: 22px;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    overflow-wrap: anywhere;
    color: #64748b;
  }
  .profile p,
  .checking p {
    margin: 8px 0 0;
  }
  .spinner {
    width: 42px;
    height: 42px;
    border: 3px solid #cbd5e1;
    border-top-color: var(--q-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .button-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  button.primary,
  button.outline {
    min-height: 44px;
    border-radius: 12px;
    color: var(--q-primary);
    border: 1px solid var(--q-primary);
  }
  button.primary {
    color: white;
    background: var(--q-primary);
  }
  label {
    display: block;
    font-size: 14px;
  }
  input:not([type='checkbox']),
  textarea {
    display: block;
    width: 100%;
    margin: 8px 0;
    color: #182236;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid transparent;
    border-radius: 12px;
  }
  .check,
  .relay label {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .banner {
    padding: 12px;
    border-radius: 8px;
    background: rgba(37, 99, 235, 0.08);
    margin: 0;
  }
  form,
  .relay {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  form label,
  .relay label {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .relay-list {
    max-height: 260px;
    overflow-y: auto;
    background: rgba(248, 250, 252, 0.94);
    border: 1px solid #cbd5e1;
    border-radius: 14px;
  }
  .relay {
    padding: 8px 12px;
    border-bottom: 1px solid #cbd5e1;
  }
  .relay-form {
    position: relative;
  }
  .relay-form input {
    padding-right: 48px;
  }
  .relay-form button.primary {
    position: absolute;
    right: 8px;
    bottom: 13px;
    width: 28px;
    min-height: 28px;
    height: 28px;
    padding: 0;
  }
  .relay:last-child {
    border: 0;
  }
  .error {
    color: #b42332;
  }
  button[data-testid='auth-onboarding-logout-button'] {
    color: #c10015;
    border-color: #c10015;
  }
  .save-spinner {
    display: inline-block;
    width: 22px;
    height: 22px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  .notification-dialog {
    width: min(440px, calc(100vw - 32px));
    color: var(--nc-text);
  }
  @media (max-width: 480px) {
    .button-row {
      grid-template-columns: 1fr;
    }
  }
</style>
