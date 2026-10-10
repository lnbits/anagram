<script lang="ts">
  import { onMount } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import {
    getBrowserNotificationPermission,
    areBrowserNotificationsEnabled,
    requestBrowserNotificationPermission,
    saveBrowserNotificationsPreference,
  } from '#src/utils/browserNotificationPreference.ts';
  import {
    isAndroidRelayNotificationSupported,
    getAndroidRelayNotificationState,
    requestAndroidRelayNotificationsAfterLogin,
    disableAndroidRelayNotifications,
    refreshAndroidRelayNotificationListener,
    setAndroidRelayNotificationStartOnBoot,
    setAndroidRelayNotificationConversationDetails,
  } from '#src/services/androidRelayNotificationService.ts';
  import {
    loadAndroidNotificationRelayChoices,
    saveAndroidNotificationRelaySelection,
    type AndroidNotificationRelayChoices,
  } from '#src/services/androidNotificationRelaySelectionService.ts';
  const android = isAndroidRelayNotificationSupported();
  let permission = getBrowserNotificationPermission(),
    enabled = areBrowserNotificationsEnabled(),
    busy = false,
    error = '';
  let androidState = {
      enabled: false,
      startOnBoot: true,
      showConversationDetails: true,
      permission: 'prompt',
    },
    choices: AndroidNotificationRelayChoices = {
      candidates: [],
      selectedRelayUrls: [],
      hasSavedSelection: false,
    };
  $: kind = permission === 'native' ? 'desktop' : 'browser';
  async function refresh() {
    if (busy) return;
    permission = getBrowserNotificationPermission();
    enabled = areBrowserNotificationsEnabled();
    if (permission === 'denied' || permission === 'unsupported')
      saveBrowserNotificationsPreference(false);
    if (android) {
      try {
        [androidState, choices] = await Promise.all([
          getAndroidRelayNotificationState(),
          loadAndroidNotificationRelayChoices(),
        ]);
      } catch {
        error = 'Could not load notification settings.';
      }
    }
  }
  async function toggle(value: boolean) {
    busy = true;
    error = '';
    try {
      if (value) permission = await requestBrowserNotificationPermission();
      enabled = value && (permission === 'granted' || permission === 'native');
      saveBrowserNotificationsPreference(enabled);
      if (value && !enabled)
        error = $translate(
          permission === 'denied'
            ? 'notifications.browser.blockedEnableInstructions'
            : 'notifications.browser.permissionDenied',
        );
    } finally {
      busy = false;
    }
  }
  async function androidAction(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch {
      error = 'Could not save notification settings. Please try again.';
    } finally {
      busy = false;
      await refresh();
    }
  }
  async function select(urls: string[]) {
    await androidAction(async () => {
      const previous = [...choices.selectedRelayUrls];
      try {
        saveAndroidNotificationRelaySelection(urls);
        await refreshAndroidRelayNotificationListener();
      } catch {
        saveAndroidNotificationRelaySelection(previous);
        throw new Error('Notification relay selection could not be saved.');
      }
    });
  }
  onMount(() => {
    void refresh();
  });
</script>

<svelte:window onfocus={() => void refresh()} />
{#if android}
  <div class="settings-card">
    <label class="settings-switch"
      ><input
        type="checkbox"
        role="switch"
        checked={androidState.enabled}
        disabled={busy ||
          (!androidState.enabled &&
            !choices.candidates.some(
              (c) => c.available && choices.selectedRelayUrls.includes(c.url),
            ))}
        onchange={(e) => {
          const value = e.currentTarget.checked;
          void androidAction(async () => {
            if (value) {
              const result = await requestAndroidRelayNotificationsAfterLogin();
              if (result !== 'granted')
                error = $translate('notifications.android.permissionDenied');
            } else await disableAndroidRelayNotifications();
          });
        }}
      /><span
        >{$translate('notifications.showAndroidPushNotifications')}<small
          >{$translate('notifications.android.toggleLabel')}</small
        ><small>{$translate('notifications.android.toggleCaption')}</small></span
      ></label
    >
    {#if androidState.permission === 'denied'}<p class="error">
        {$translate('notifications.android.blockedInstructions')}
      </p>{/if}
    {#each [['startOnBoot', 'notifications.android.startOnBoot'], ['showConversationDetails', 'notifications.android.showConversationDetails']] as [key, label]}<label
        class="settings-switch"
        ><input
          type="checkbox"
          role="switch"
          checked={key === 'startOnBoot'
            ? androidState.startOnBoot
            : androidState.showConversationDetails}
          disabled={busy || !androidState.enabled}
          onchange={(e) => {
            const value = e.currentTarget.checked;
            void androidAction(() =>
              key === 'startOnBoot'
                ? setAndroidRelayNotificationStartOnBoot(value)
                : setAndroidRelayNotificationConversationDetails(value),
            );
          }}
        /><span>{$translate(label)}<small>{$translate(`${label}Caption`)}</small></span></label
      >{/each}
    <small>{$translate('notifications.android.privacyCaption')}</small>
  </div>
  <div class="settings-card">
    <div>
      <h3>{$translate('notifications.android.relays.title')}</h3>
      <small>{$translate('notifications.android.relays.caption')}</small>
    </div>
    <div class="settings-actions">
      <button
        class="link"
        disabled={busy}
        onclick={() => select(choices.candidates.filter((c) => c.available).map((c) => c.url))}
        >{$translate('notifications.android.relays.selectAll')}</button
      ><button class="link" disabled={busy || androidState.enabled} onclick={() => select([])}
        >{$translate('notifications.android.relays.clear')}</button
      >
    </div>
    {#each choices.candidates as candidate}<label class="settings-switch"
        ><input
          type="checkbox"
          checked={choices.selectedRelayUrls.includes(candidate.url)}
          disabled={busy ||
            !candidate.available ||
            (androidState.enabled &&
              choices.selectedRelayUrls.length === 1 &&
              choices.selectedRelayUrls.includes(candidate.url))}
          onchange={(e) =>
            select(
              e.currentTarget.checked
                ? [...choices.selectedRelayUrls, candidate.url]
                : choices.selectedRelayUrls.filter((url) => url !== candidate.url),
            )}
        /><span
          >{candidate.url}<small
            >{candidate.sources
              .map((source) => $translate(`notifications.android.relays.${source}`))
              .join(' · ')}{!candidate.available
              ? $translate('notifications.android.relays.unavailableCaption')
              : ''}</small
          ></span
        ></label
      >{:else}<p>{$translate('notifications.android.relays.empty')}</p>{/each}
    {#if choices.selectedRelayUrls.length > 5}<p class="error">
        {$translate('notifications.android.relays.batteryWarning')}
      </p>{/if}
  </div>
{:else}
  <div class="settings-card notification-card">
    <label class="settings-switch notification-toggle"
      ><input
        type="checkbox"
        role="switch"
        data-testid="settings-notifications-toggle"
        checked={enabled}
        disabled={busy || permission === 'unsupported'}
        onchange={(e) => toggle(e.currentTarget.checked)}
      /><span
        >{$translate(
          kind === 'desktop'
            ? 'notifications.showDesktopNotifications'
            : 'notifications.showBrowserNotifications',
        )}<small>{$translate(`notifications.${kind}.toggleLabel`)}</small><small
          >{$translate(`notifications.${kind}.toggleCaption`)}</small
        ></span
      ></label
    >
    {#if permission === 'denied'}<p class="error">
        {$translate('notifications.browser.blockedInstructions')}
      </p>{:else if permission === 'unsupported'}<p>
        {$translate('notifications.browser.unsupported')}
      </p>{/if}
  </div>
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}
