<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { disableAndroidRelayNotifications } from '#src/services/androidRelayNotificationService.ts';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { toStore } from 'svelte/store';
  import { translate } from '#src/i18n.ts';
  import Icon from '../Icon.svelte';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useChatStore } from '#src/stores/chatStore.ts';
  import { useAppUpdateStore } from '#src/stores/appUpdateStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import {
    readDesktopSidebarWidthPreference,
    saveDesktopSidebarWidthPreference,
    MIN_DESKTOP_SIDEBAR_WIDTH,
    MAX_DESKTOP_SIDEBAR_WIDTH,
  } from '#src/utils/themeStorage.ts';
  import './settings.css';
  const route = toStore(() => page.url.pathname);
  const nostr = useNostrStore(),
    update = useAppUpdateStore();
  const state = observe(() => ({
    update: update.hasUpdateAvailable,
    unread: useChatStore().unreadChatCount,
  }));
  const items = [
    ['profile', 'profile.profile', 'face'],
    ['relays', 'relays.title', 'satellite_alt'],
    ['notifications', 'notifications.notifications', 'notifications'],
    ['media-data-storage', 'mediaDataStorage.title', 'storage'],
    ['theme', 'settings.appearance', 'wallpaper'],
    ['language', 'settings.language.titlePlural', 'language'],
    ['developer', 'developer.developer', 'terminal'],
  ];
  export let width = readDesktopSidebarWidthPreference();
  let developerPanel: { refresh: () => Promise<void> } | undefined;
  let resizing = false;
  let mobile = matchMedia('(max-width: 767px)').matches;
  let confirmation: '' | 'logout' | 'refresh' = '',
    busy = false,
    error = '';
  let dialog: HTMLDialogElement;
  $: slug = $route.split('/')[2] || '';
  $: item =
    items.find(([id]) => id === slug) ??
    (slug === 'status' ? ['status', 'common.status', 'info'] : items[0]);
  $: if (!mobile && !slug) void goto('/settings/profile', { replaceState: true });
  function resize(value: number) {
    width = Math.round(
      Math.max(
        MIN_DESKTOP_SIDEBAR_WIDTH,
        Math.min(value, MAX_DESKTOP_SIDEBAR_WIDTH, innerWidth * 0.75),
      ),
    );
    saveDesktopSidebarWidthPreference(width);
  }
  function confirm(action: typeof confirmation) {
    confirmation = action;
    error = '';
    dialog.showModal();
  }
  async function perform() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      if (confirmation === 'logout') {
        await disableAndroidRelayNotifications();
        nostr.stopAppLifecycleRuntime();
        await nostr.logout();
        window.location.replace('/');
      } else {
        const result = await update.forceRefresh();
        if ('reason' in result)
          error = $translate(
            result.reason === 'server-unreachable'
              ? 'settings.serverReachableForceRefresh'
              : 'settings.forceRefreshSupportedBrowser',
          );
      }
    } catch {
      error = $translate(confirmation === 'logout' ? 'errors.failedLogOut' : 'common.tryAgain');
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void update.checkForUpdate({ force: true });
  });
</script>

<svelte:window
  onresize={() => (mobile = matchMedia('(max-width: 767px)').matches)}
  onpointermove={(e) => {
    if (resizing) resize(e.clientX);
  }}
  onpointerup={() => (resizing = false)}
  onblur={() => (resizing = false)}
/>
<div
  class="app-shell settings-shell"
  class:show-thread={!!slug}
  style:--desktop-sidebar-width={`${width}px`}
>
  <aside class="sidebar">
    <header class="sidebar-header">
      <h1>{$translate('settings.settings')}</h1>
      <button
        class="icon-button"
        data-testid="settings-force-refresh-button"
        aria-label={$translate('settings.forceRefresh')}
        onclick={() => confirm('refresh')}
        ><Icon name="refresh" />{#if $state.update}<span class="update-dot"></span>{/if}</button
      >
    </header>
    <div class="sidebar-content">
      {#each items as [id, title, icon]}<button
          class="settings-item"
          class:active={slug === id}
          data-testid={`settings-${id}-item`}
          onclick={() => goto(`/settings/${id}`)}
          ><Icon name={icon} /><span>{$translate(title)}</span></button
        >{/each}
      <button
        class="settings-item danger-text"
        data-testid="settings-logout-item"
        onclick={() => confirm('logout')}
        ><Icon name="logout" /><span>{$translate('settings.logOut')}</span></button
      >
    </div>
    <nav class="nav-rail" aria-label="Main navigation">
      {#each ['chats', 'contacts', 'settings'] as target}<button
          class="nav-rail__btn"
          class:nav-rail__btn--active={target === 'settings'}
          aria-label={target}
          onclick={() => goto(`/${target}`)}
          ><Icon name={target} />{#if target === 'chats' && $state.unread}<span
              class="badge nav-badge">{$state.unread}</span
            >{/if}</button
        >{/each}
    </nav>
  </aside>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div
    class="sidebar-resizer"
    role="separator"
    aria-label="Resize left panel"
    aria-orientation="vertical"
    aria-valuemin={MIN_DESKTOP_SIDEBAR_WIDTH}
    aria-valuemax={Math.min(MAX_DESKTOP_SIDEBAR_WIDTH, innerWidth * 0.75)}
    aria-valuenow={width}
    tabindex="0"
    onpointerdown={(e) => {
      e.preventDefault();
      resizing = true;
    }}
    onkeydown={(e) => {
      if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        resize(width + (e.key === 'ArrowLeft' ? -16 : 16));
      }
    }}
  ></div>
  <main class="main-panel">
    <header class="settings-detail-header">
      <button
        class="icon-button mobile-back"
        aria-label={$translate('settings.backSettings')}
        onclick={() => goto('/settings')}><Icon name="back" /></button
      ><Icon name={item[2]} />
      <h2>{$translate(item[1])}</h2>
      {#if item[0] === 'developer'}<div class="settings-detail-actions">
          <button class="link" onclick={() => developerPanel?.refresh()}
            ><Icon name="refresh" />{$translate('common.refresh')}</button
          >
        </div>{/if}
    </header>
    <div class="settings-body">
      {#key item[0]}
        {#if item[0] === 'profile'}{#await import('./ProfileSettings.svelte') then component}<component.default
            />{/await}
        {:else if item[0] === 'relays'}{#await import('./RelaySettings.svelte') then component}<component.default
            />{/await}
        {:else if item[0] === 'notifications'}{#await import('./NotificationSettings.svelte') then component}<component.default
            />{/await}
        {:else if item[0] === 'developer' || item[0] === 'status'}{#await import('./DeveloperSettings.svelte') then component}<component.default
              bind:this={developerPanel}
            />{/await}
        {:else}{#await import('./PreferenceSettings.svelte') then component}<component.default
              section={item[0]}
            />{/await}{/if}
      {/key}
    </div>
  </main>
</div>
<dialog
  bind:this={dialog}
  use:dismissOnBackdrop={() => { if (!busy) dialog.close(); }}
  class="settings-dialog"
  oncancel={(e) => {
    if (busy) e.preventDefault();
  }}
>
  <h2>{$translate(confirmation === 'logout' ? 'settings.logOut' : 'settings.forceRefresh')}</h2>
  {#if confirmation === 'logout'}<p>{$translate('settings.logout.confirmation')}</p>
    <p>{$translate('settings.logout.redirectNotice')}</p>{:else}{#if $state.update}<p>
        {$translate('settings.forceRefresh.newVersionNotice')}
      </p>{/if}
    <p>{$translate('settings.forceRefreshOnlyStart')}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  <div class="settings-actions">
    <button class="outline" disabled={busy} onclick={() => dialog.close()}
      >{$translate('common.cancel')}</button
    ><button
      class:danger={confirmation === 'logout'}
      class:primary={confirmation !== 'logout'}
      disabled={busy}
      data-testid={`settings-${confirmation === 'logout' ? 'logout' : 'force-refresh'}-confirm`}
      onclick={perform}
      >{$translate(confirmation === 'logout' ? 'settings.logOut' : 'settings.forceRefresh')}</button
    >
  </div>
</dialog>
