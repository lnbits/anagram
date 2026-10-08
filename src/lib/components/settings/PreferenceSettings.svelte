<script lang="ts">
  import { onMount } from 'svelte';
  import { locale, languageOptions, setLocale, translate } from '#src/i18n.ts';
  import {
    readDarkModePreference,
    saveDarkModePreference,
    readDesktopMessageLayoutPreference,
    saveDesktopMessageLayoutPreference,
  } from '#src/utils/themeStorage.ts';
  import {
    DEFAULT_BLOSSOM_SERVER_URL,
    DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL,
    getBlossomServerHost,
    normalizeBlossomServerUrl,
  } from '#src/utils/blossomServer.ts';
  import { verifyPrivateMediaServer } from '#src/services/blossomUploadService.ts';
  import {
    isPrivateMediaNoticeDismissed,
    setPrivateMediaNoticeDismissed,
  } from '#src/utils/privateMediaNoticePreference.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import Icon from '../Icon.svelte';
  export let section: string;
  const nostr = useNostrStore();
  const startup = observe(() => nostr.isRestoringStartupState);
  let dark = readDarkModePreference() ?? document.body.classList.contains('body--dark');
  let layout = readDesktopMessageLayoutPreference();
  let saved = nostr.getBlossomServerUrl(),
    server = saved,
    busy = false,
    error = '',
    notice = '';
  $: normalized = normalizeBlossomServerUrl(server);
  $: if (!$startup && !busy && server === saved) {
    saved = nostr.getBlossomServerUrl();
    server = saved;
  }
  async function persist(value: string) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      saved = await nostr.saveBlossomServerUrl(value);
      server = saved;
      notice = $translate('mediaDataStorage.serverSaved');
    } catch {
      error = $translate('mediaDataStorage.serverSaveFailed');
    } finally {
      busy = false;
    }
  }
  // Encrypted private media server, saved separately from the regular Blossom server.
  let privateSaved = nostr.getPrivateMediaBlossomServerUrl(),
    privateServer = privateSaved,
    privateBusy = false,
    privateError = '',
    privateNotice = '',
    testing = false;
  // Same preference as the upload notice's "Don't show this again". It only controls that
  // informational notice; private media is always encrypted either way.
  let showPrivateMediaNotice = !isPrivateMediaNoticeDismissed();
  $: privateNormalized = normalizeBlossomServerUrl(privateServer);
  $: if (!$startup && !privateBusy && privateServer === privateSaved) {
    privateSaved = nostr.getPrivateMediaBlossomServerUrl();
    privateServer = privateSaved;
  }
  async function persistPrivate(value: string) {
    if (privateBusy) return;
    privateBusy = true;
    privateError = '';
    privateNotice = '';
    try {
      privateSaved = await nostr.savePrivateMediaBlossomServerUrl(value);
      privateServer = privateSaved;
      privateNotice = $translate('mediaDataStorage.privateMediaServerSaved');
    } catch {
      privateError = $translate('mediaDataStorage.privateMediaServerSaveFailed');
    } finally {
      privateBusy = false;
    }
  }
  // Tests whichever URL is in the field, so a server can be verified before it is saved.
  async function testPrivateServer() {
    const serverUrl = privateNormalized;
    if (!serverUrl || testing) return;
    testing = true;
    privateError = '';
    privateNotice = '';
    try {
      await nostr.ensureBlossomUploadAuthentication();
      const { cleanedUp } = await verifyPrivateMediaServer({
        serverUrl,
        signUploadAuthHeader: nostr.signBlossomUploadAuthHeader,
      });
      privateNotice = $translate(
        cleanedUp
          ? 'mediaDataStorage.testServerPassed'
          : 'mediaDataStorage.testServerPassedNoCleanup',
        { server: getBlossomServerHost(serverUrl) },
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message.trim() : '';
      privateError = [$translate('mediaDataStorage.testServerFailed'), detail]
        .filter(Boolean)
        .join(' ');
    } finally {
      testing = false;
    }
  }
  function sync() {
    if (!busy && server === saved) {
      saved = nostr.getBlossomServerUrl();
      server = saved;
    }
    if (!privateBusy && privateServer === privateSaved) {
      privateSaved = nostr.getPrivateMediaBlossomServerUrl();
      privateServer = privateSaved;
    }
    showPrivateMediaNotice = !isPrivateMediaNoticeDismissed();
  }
  onMount(() => {
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  });
</script>

{#if section === 'theme'}
  <div class="settings-card theme-card">
    <div class="theme-setting">
      <div>
        <h3>{$translate('settings.appearance')}</h3>
        <small>{$translate('settings.theme.description')}</small>
      </div>
      <label class="settings-switch"
        ><span>{$translate('common.darkMode')}</span><input
          type="checkbox"
          role="switch"
          aria-label={$translate('common.darkMode')}
          checked={dark}
          onchange={(e) => {
            dark = e.currentTarget.checked;
            saveDarkModePreference(dark);
            localStorage.setItem('anagram-theme', dark ? 'dark' : 'light');
            document.body.classList.toggle('body--dark', dark);
          }}
        /></label
      >
    </div>
    <hr />
    <div>
      <h3>{$translate('settings.desktopMessageLayout.title')}</h3>
      <small>{$translate('settings.desktopMessageLayout.description')}</small>
    </div>
    <label class="settings-select-field"
      ><span>{$translate('settings.desktopMessageLayout.title')}</span><select
        aria-label={$translate('settings.desktopMessageLayout.title')}
        data-testid="settings-desktop-message-layout-toggle"
        bind:value={layout}
        onchange={() => saveDesktopMessageLayoutPreference(layout)}
        >{#each ['text', 'bubbles'] as option}<option value={option}
            >{$translate(`settings.desktopMessageLayout.${option}`)}</option
          >{/each}</select
      ></label
    >
  </div>
{:else if section === 'language'}
  <div class="settings-card language-card">
    <div>
      <h3>{$translate('settings.language.field')}</h3>
      <small>{$translate('settings.language.description')}</small>
    </div>
    <label class="settings-select-field"
      ><span>{$translate('settings.language.title')}</span><select
        aria-label={$translate('settings.language.title')}
        value={$locale}
        onchange={(e) => setLocale(e.currentTarget.value as typeof $locale)}
        >{#each languageOptions as language}<option value={language.code}
            >{language.nativeName === language.englishName
              ? language.nativeName
              : `${language.nativeName} - ${language.englishName}`}
          </option>{/each}</select
      ></label
    >
  </div>
{:else}
  <div class="settings-card media-card" data-testid="settings-private-media-card">
    <div>
      <h3>{$translate('mediaDataStorage.privateMediaServer')}</h3>
      <small>{$translate('mediaDataStorage.privateMediaServerDescription')}</small>
    </div>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (privateNormalized && privateNormalized !== privateSaved)
          void persistPrivate(privateNormalized);
      }}
    >
      <label class="settings-field settings-field--tall"
        ><span>{$translate('mediaDataStorage.serverUrl')}</span><input
          data-testid="settings-private-media-server-input"
          type="url"
          bind:value={privateServer}
          disabled={privateBusy || $startup}
          spellcheck="false"
          autocapitalize="none"
        /></label
      ><small class="settings-caption">{$translate('mediaDataStorage.testServerHint')}</small>
      {#if !privateNormalized}<p class="error">
          {$translate(
            privateServer.trim()
              ? 'mediaDataStorage.serverUrlInvalid'
              : 'mediaDataStorage.serverUrlRequired',
          )}
        </p>{/if}
      <div class="settings-actions end">
        <button
          type="button"
          class="outline"
          data-testid="settings-private-media-test"
          disabled={testing || privateBusy || $startup || !privateNormalized}
          onclick={testPrivateServer}
          >{$translate(testing ? 'mediaDataStorage.testingServer' : 'mediaDataStorage.testServer')}</button
        ><button
          type="button"
          class="outline"
          data-testid="settings-private-media-restore-default"
          disabled={privateBusy ||
            $startup ||
            (privateServer === DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL &&
              privateSaved === DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL)}
          onclick={() => persistPrivate(DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL)}
          >{$translate('mediaDataStorage.restoreDefault')}</button
        ><button
          class="primary"
          data-testid="settings-private-media-save"
          disabled={privateBusy || $startup || !privateNormalized || privateNormalized === privateSaved}
          >{$translate('common.save')}</button
        >
      </div>
    </form>
    <label class="settings-switch"
      ><span>{$translate('mediaDataStorage.showPrivateMediaNotice')}</span><input
        type="checkbox"
        role="switch"
        data-testid="settings-private-media-notice-toggle"
        aria-label={$translate('mediaDataStorage.showPrivateMediaNotice')}
        checked={showPrivateMediaNotice}
        onchange={(e) => {
          setPrivateMediaNoticeDismissed(!e.currentTarget.checked);
          showPrivateMediaNotice = !isPrivateMediaNoticeDismissed();
        }}
      /></label
    >
    <div class="settings-actions settings-caption">
      <Icon name="lock" />{$translate('mediaDataStorage.encryptedPreference')}
    </div>
    {#if privateError}<p class="error" role="alert">{privateError}</p>{/if}{#if privateNotice}<p
        role="status"
      >
        {privateNotice}
      </p>{/if}
  </div>
  <div class="settings-card media-card">
    <div>
      <h3>{$translate('mediaDataStorage.blossomServer')}</h3>
      <small>{$translate('mediaDataStorage.blossomServerDescription')}</small>
    </div>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (normalized && normalized !== saved) void persist(normalized);
      }}
    >
      <label class="settings-field settings-field--tall"
        ><span>{$translate('mediaDataStorage.serverUrl')}</span><input
          data-testid="settings-blossom-server-input"
          type="url"
          bind:value={server}
          disabled={busy || $startup}
          spellcheck="false"
          autocapitalize="none"
        /></label
      ><small class="settings-caption">{$translate('mediaDataStorage.serverUrlHint')}</small>
      {#if !normalized}<p class="error">
          {$translate(
            server.trim()
              ? 'mediaDataStorage.serverUrlInvalid'
              : 'mediaDataStorage.serverUrlRequired',
          )}
        </p>{/if}
      <div class="settings-actions end">
        <button
          type="button"
          class="outline"
          data-testid="settings-blossom-restore-default"
          disabled={busy ||
            $startup ||
            (server === DEFAULT_BLOSSOM_SERVER_URL && saved === DEFAULT_BLOSSOM_SERVER_URL)}
          onclick={() => persist(DEFAULT_BLOSSOM_SERVER_URL)}
          >{$translate('mediaDataStorage.restoreDefault')}</button
        ><button
          class="primary"
          data-testid="settings-blossom-save"
          disabled={busy || $startup || !normalized || normalized === saved}
          >{$translate('common.save')}</button
        >
      </div>
    </form>
    <div class="settings-actions settings-caption">
      <Icon name="lock" />{$translate('mediaDataStorage.encryptedPreference')}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p role="status">
        {notice}
      </p>{/if}
  </div>
{/if}
