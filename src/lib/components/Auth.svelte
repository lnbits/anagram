<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
  import QRCode from 'qrcode';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { translate } from '#src/i18n.ts';
  import {
    readTopLevelBunkerLoginQueryParam,
    removeTopLevelBunkerLoginQueryParam,
  } from '#src/utils/bunkerLoginQuery.ts';
  import AuthOnboarding from './AuthOnboarding.svelte';
  import Icon from './Icon.svelte';
  export let onlogin: () => void;
  let step: 'welcome' | 'methods' | 'key' | 'remote' | 'create' | 'onboarding' = 'welcome';
  let key = '',
    error = '',
    created = '',
    createdNpub = '',
    pairingRelay = 'wss://relay.nsec.app',
    qr = '',
    authUrl = '';
  let busy = false,
    extensionAvailable = false,
    generating = false;
  let remoteMode: 'bunker' | 'nostrconnect' = 'bunker';
  let onboarding: AuthOnboarding | undefined;
  let onboardingCanGoBack = false;
  let onboardingBusy = false;
  let onboardingTitle = 'profile.checkingProfile',
    onboardingSubtitle = 'relays.stayHereAppChecks';
  let generation = 0;
  let loginAbort: AbortController | null = null;
  let createTimer: ReturnType<typeof setTimeout> | undefined;
  let pairing: ReturnType<
    ReturnType<typeof useNostrStore>['createRemoteSignerNostrConnectLogin']
  > | null = null;
  $: title =
    step === 'welcome'
      ? 'common.welcome'
      : step === 'create'
        ? 'common.createAccount'
        : step === 'remote'
          ? 'auth.remoteSigner'
          : step === 'key'
            ? 'auth.loginKey'
            : step === 'onboarding'
              ? onboardingTitle
              : 'auth.login';
  $: subtitle =
    step === 'welcome'
      ? 'common.chooseHowYouWant'
      : step === 'methods'
        ? 'auth.chooseLoginMethod'
        : step === 'remote'
          ? 'auth.connectNip46'
          : step === 'create'
            ? generating
              ? 'common.creatingAccount'
              : 'auth.generatedKeypairSecretNotice'
            : step === 'onboarding'
              ? onboardingSubtitle
              : 'auth.enterNsecHexPrivate';
  onMount(() => {
    extensionAvailable = useNostrStore().hasNip07Extension() && !('__TAURI_INTERNALS__' in window);
    const bunker = readTopLevelBunkerLoginQueryParam();
    removeTopLevelBunkerLoginQueryParam();
    if (localStorage.getItem('npub') && localStorage.getItem('anagram-onboarding-pending'))
      step = 'onboarding';
    else if (bunker) {
      step = 'remote';
      key = bunker;
      void login('bunker');
    }
  });
  function receiveAuthUrl(url: string) {
    try {
      const parsed = new URL(url);
      if (['https:', 'http:'].includes(parsed.protocol)) authUrl = parsed.href;
    } catch {
      /* Ignore invalid signer URLs. */
    }
  }
  async function login(kind: 'key' | 'extension' | 'bunker' | 'pair') {
    if (busy) return;
    const attempt = ++generation;
    busy = true;
    error = '';
    authUrl = '';
    loginAbort = new AbortController();
    try {
      const nostr = useNostrStore();
      if (kind === 'extension') await nostr.loginWithExtension();
      else if (kind === 'bunker')
        await nostr.loginWithRemoteSignerBunker({
          signal: loginAbort.signal,
          connectionToken: key,
          onAuthUrl: receiveAuthUrl,
        });
      else if (kind === 'pair') {
        const relay = new URL(pairingRelay.trim());
        if (!['ws:', 'wss:'].includes(relay.protocol)) throw new Error();
        pairing = nostr.createRemoteSignerNostrConnectLogin({
          relayUrl: relay.href,
          onAuthUrl: receiveAuthUrl,
        });
        qr = await QRCode.toDataURL(pairing.uri, { width: 280, margin: 2 });
        await pairing.login;
      } else if (!(await nostr.savePrivateKey(key)).isValid) {
        error = 'Enter a valid nsec or private key.';
        return;
      }
      if (attempt !== generation) return;
      key = '';
      created = '';
      createdNpub = '';
      pairing = null;
      qr = '';
      authUrl = '';
      localStorage.setItem('anagram-onboarding-pending', '1');
      step = 'onboarding';
    } catch {
      // Signer and parser errors may embed input. Never echo an nsec/token.
      if (attempt === generation)
        error =
          kind === 'key'
            ? 'Enter a valid nsec or private key.'
            : 'Unable to connect to the signer. Please try again.';
    } finally {
      if (attempt === generation) busy = false;
    }
  }
  function generate() {
    error = '';
    step = 'create';
    generating = true;
    const secret = generateSecretKey();
    try {
      created = nip19.nsecEncode(secret);
      createdNpub = nip19.npubEncode(getPublicKey(secret));
      key = created;
    } finally {
      secret.fill(0);
    }
    createTimer = setTimeout(() => {
      generating = false;
    }, 2000);
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob(
        [
          `Anagram account\nPublic key: ${createdNpub}\nPrivate key: ${created}\nKeep your private key secret.\n`,
        ],
        { type: 'text/plain' },
      ),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'anagram-account-secret.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function cancel() {
    generation++;
    loginAbort?.abort();
    loginAbort = null;
    pairing?.cancel();
    pairing = null;
    busy = false;
    qr = '';
    authUrl = '';
  }
  function back() {
    cancel();
    error = '';
    key = '';
    created = '';
    createdNpub = '';
    clearTimeout(createTimer);
    step = step === 'methods' || step === 'create' ? 'welcome' : 'methods';
  }
  async function copyPairing() {
    try {
      if (pairing) await navigator.clipboard.writeText(pairing.uri);
    } catch {
      error = 'Unable to copy pairing link.';
    }
  }
  onDestroy(() => {
    cancel();
    clearTimeout(createTimer);
    key = '';
    created = '';
  });
</script>

<div class="auth-page auth-entry-page">
  <div class="auth-shell" class:wide={step === 'onboarding'}>
    <div class="auth-card">
      <header class="auth-header">
        {#if (step !== 'welcome' && step !== 'onboarding') || (onboardingCanGoBack && step === 'onboarding')}<button
            class="icon-button back"
            aria-label="Back"
            onclick={() => (step === 'onboarding' ? onboarding?.backToRelays() : back())}
            disabled={busy || onboardingBusy}><Icon name="back" /></button
          >{/if}
        <div>
          <h1>{$translate(title)}</h1>
          <p>{$translate(subtitle)}</p>
        </div>
      </header>
      <div class="auth-actions" class:remote-signer={step === 'remote'}>
        {#if step === 'welcome'}
          <button
            class="primary"
            data-testid="auth-open-login-button"
            onclick={() => (step = 'methods')}
            ><Icon name="login" />{$translate('auth.login')}</button
          >
          <button class="outline" onclick={generate}
            ><Icon name="key" />{$translate('common.createAccount')}</button
          >
        {:else if step === 'methods'}
          {#if extensionAvailable}<button
              class="primary"
              onclick={() => login('extension')}
              disabled={busy}
              >{#if busy}<span class="auth-spinner" aria-label="Connecting"></span>{:else}<Icon
                  name="extension"
                />{$translate('auth.loginExtension')}{/if}</button
            >{/if}
          <button class="primary" onclick={() => (step = 'remote')} disabled={busy}
            ><Icon name="lock" />{$translate('auth.loginRemoteSigner')}</button
          >
          <button
            class="outline"
            data-testid="auth-open-key-button"
            onclick={() => {
              step = 'key';
              key = '';
            }}
            disabled={busy}><Icon name="key" />{$translate('auth.loginKeyRecommended')}</button
          >
        {:else if step === 'create'}
          {#if generating}<div
              class="creation-progress"
              role="progressbar"
              aria-label={$translate('common.creatingAccount')}
            ></div>
          {:else}<button class="outline" onclick={download}
              ><Icon name="download" />{$translate('auth.downloadAccountSecret')}</button
            ><button class="primary" disabled={busy} onclick={() => login('key')}
              >{#if busy}<span class="auth-spinner" aria-label="Connecting"></span>{:else}<Icon
                  name="login"
                />{$translate('auth.loginNow')}{/if}</button
            >{/if}
        {:else if step === 'key'}
          <div class="key-warning">
            <Icon name="warning" /><span>{$translate('auth.enteringPrivateKeyStrongly')}</span>
          </div>
          <form
            class="key-form"
            onsubmit={(e) => {
              e.preventDefault();
              void login('key');
            }}
          >
            <label class="key-field" for="private-key"
              ><input
                id="private-key"
                data-testid="auth-private-key-input"
                type="password"
                bind:value={key}
                placeholder=" "
                aria-label={$translate('auth.privateKeyNsecHex')}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                disabled={busy}
              />
              <span>{$translate('auth.privateKeyNsecHex')}</span></label
            >
            <button class="primary" data-testid="auth-login-button" disabled={busy || !key}
              >{#if busy}<span class="auth-spinner" aria-label="Connecting"
                ></span>{:else}{$translate('auth.login')}{/if}</button
            >
          </form>
        {:else if step === 'remote'}
          <div class="remote-tabs" role="tablist" aria-label="Remote signer method">
            <button
              role="tab"
              aria-selected={remoteMode === 'bunker'}
              disabled={busy}
              onclick={() => (remoteMode = 'bunker')}>{$translate('auth.bunkerUrl')}</button
            ><button
              role="tab"
              aria-selected={remoteMode === 'nostrconnect'}
              disabled={busy}
              onclick={() => (remoteMode = 'nostrconnect')}
              >{$translate('auth.nostrConnect')}</button
            >
          </div>
          {#if remoteMode === 'bunker'}
            <form
              onsubmit={(e) => {
                e.preventDefault();
                void login('bunker');
              }}
            >
              <label
                >{$translate('auth.bunkerConnectionString')}<textarea
                  bind:value={key}
                  placeholder="bunker://…"
                  onkeydown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void login('bunker');
                    }
                  }}
                  autocomplete="off"
                  spellcheck="false"
                  disabled={busy}
                  data-testid="auth-remote-signer-bunker-input"></textarea></label
              ><button
                class="primary"
                disabled={busy || !key}
                data-testid="auth-remote-signer-bunker-connect-button"
                >{#if busy}<span class="auth-spinner" aria-label="Connecting"></span>{:else}<Icon
                    name="login"
                  />{$translate('common.connect')}{/if}</button
              >
            </form>
          {:else}
            <label
              >{$translate('relays.pairingRelay')}<input
                bind:value={pairingRelay}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void login('pair');
                  }
                }}
                placeholder="wss://relay.example.com"
                disabled={busy}
                data-testid="auth-remote-signer-relay-input"
              /></label
            >
            <button
              class="primary"
              onclick={() => login('pair')}
              disabled={busy || !pairingRelay}
              data-testid="auth-remote-signer-create-nostrconnect-button"
              >{#if busy}<span class="auth-spinner" aria-label="Connecting"></span>{:else}<Icon
                  name="add"
                />{$translate('common.generatePairingLink')}{/if}</button
            >
            {#if pairing}
              {#if qr}<img
                  class="pairing-qr"
                  src={qr}
                  alt={$translate('auth.nostrConnectPairingQr')}
                  data-testid="auth-remote-signer-nostrconnect-qr"
                />{/if}
              <textarea
                readonly
                aria-label="nostrconnect://"
                value={pairing.uri}
                data-testid="auth-remote-signer-nostrconnect-uri"></textarea>
              <div class="button-row">
                <button
                  class="outline"
                  onclick={copyPairing}
                  data-testid="auth-remote-signer-copy-button">{$translate('common.copy')}</button
                ><a
                  class="primary pairing-open"
                  href={pairing.uri}
                  data-testid="auth-remote-signer-open-button">{$translate('common.open')}</a
                >
              </div>
            {/if}
          {/if}
          {#if authUrl}<a href={authUrl} target="_blank" rel="noopener noreferrer"
              >{$translate('auth.openSignerAuthorization')}</a
            >{/if}
          {#if busy}<button
              class="cancel"
              onclick={cancel}
              data-testid="auth-remote-signer-cancel-button">{$translate('common.cancel')}</button
            >{/if}
        {:else}<AuthOnboarding
            bind:this={onboarding}
            bind:canGoBack={onboardingCanGoBack}
            bind:busy={onboardingBusy}
            bind:title={onboardingTitle}
            bind:subtitle={onboardingSubtitle}
            oncomplete={onlogin}
            onlogout={() => (step = 'welcome')}
          />{/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
      </div>
      <footer>
        {$translate('common.made')}<a
          href="https://lnbits.com"
          target="_blank"
          rel="noopener noreferrer"><img src="/lnbits.svg" alt="" /> LNbits</a
        >{$translate('common.team')}
      </footer>
    </div>
  </div>
</div>

<style>
  .auth-page {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .auth-shell {
    width: min(100%, 460px);
  }
  .auth-card {
    border-radius: 20px;
    border: 1px solid rgba(208, 220, 235, 0.82);
    overflow: hidden;
    background: rgba(239, 246, 251, 0.9);
    color: #182236;
    box-shadow: 0 18px 40px rgba(17, 40, 76, 0.16);
    backdrop-filter: blur(18px);
  }
  .auth-header {
    min-height: 128px;
    padding: 22px 22px 10px;
    display: flex;
    gap: 10px;
    background: rgba(255, 255, 255, 0.82);
    border-bottom: 1px solid rgba(208, 220, 235, 0.82);
  }
  .auth-header > div {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  h1 {
    font-size: 28px;
    line-height: 1.1;
    margin: 0;
    font-weight: 700;
  }
  .auth-header p {
    margin: 8px 0 0;
    opacity: 0.75;
    line-height: 1.5;
  }
  .back {
    color: #2563eb;
    margin: -2px 0 0;
    width: 33.6px;
    height: 33.6px;
    flex-shrink: 0;
  }
  .auth-actions {
    display: grid;
    gap: 12px;
    padding: 10px 22px 22px;
  }
  .auth-actions button.primary,
  .auth-actions button.outline {
    width: 100%;
    min-height: 44px;
    padding: 4px 16px;
    font-weight: 600;
    line-height: 24px;
    border-radius: 12px;
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
  }
  .primary {
    background: var(--q-primary);
    color: white;
  }
  .outline {
    border: 1px solid rgba(37, 99, 235, 0.55);
    color: var(--q-primary);
    background: rgba(255, 255, 255, 0.18);
  }
  label {
    display: block;
    font-size: 13px;
    line-height: 1.6;
  }
  .auth-actions input:not([type='checkbox']),
  textarea {
    width: 100%;
    margin: 8px 0 14px;
    background: #fff;
    color: #182236;
    border: 1px solid #cbd5e1;
  }
  .error {
    color: #b42332;
    margin: 0;
  }
  .pairing-qr {
    display: block;
    width: min(100%, 280px);
    padding: 12px;
    border: 1px solid rgba(208, 220, 235, 0.92);
    border-radius: 12px;
    background: white;
    margin: auto;
  }
  .remote-signer {
    gap: 14px;
  }
  .remote-signer textarea[readonly] {
    font-family: monospace;
    font-size: 12px;
    line-height: 1.35;
  }
  footer {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 6px;
    height: 64px;
    padding: 10px 22px 14px;
    color: #64748b;
    font-size: 13px;
    border-top: 1px solid rgba(208, 220, 235, 0.72);
    background: rgba(255, 255, 255, 0.48);
  }
  footer a {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #2563eb;
    font-weight: 700;
    text-decoration: none;
  }
  footer img {
    width: 18px;
    height: 18px;
    border-radius: 50%;
  }
  .wide {
    width: min(100%, 560px);
  }
  .button-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .remote-tabs {
    display: flex;
    border-radius: 14px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.78);
    color: #334155;
  }
  .remote-tabs button {
    flex: 1;
    padding: 12px 8px;
    border-bottom: 2px solid transparent;
  }
  .remote-tabs button[aria-selected='true'] {
    color: #2563eb;
    border-bottom-color: #2563eb;
  }
  .key-warning {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid #f3c969;
    border-radius: 4px;
    background: #fff7db;
    color: #7c4a03;
    font-weight: 600;
  }
  .key-warning :global(svg) {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    color: #b26b00;
  }
  .key-form {
    display: grid;
    gap: 32px;
  }
  .key-field {
    position: relative;
    height: 40px;
  }
  .key-field span {
    position: absolute;
    left: 12px;
    top: 9px;
    color: #596579;
    font-size: 14px;
    pointer-events: none;
    transition: all 0.15s;
  }
  .auth-actions .key-field input {
    margin: 0;
    height: 40px;
    border: 0;
    border-radius: 12px;
    padding: 14px 12px 0;
  }
  .key-field input:focus + span,
  .key-field input:not(:placeholder-shown) + span {
    top: 2px;
    font-size: 10px;
  }
  .auth-actions button:disabled {
    opacity: 0.6;
  }
  .cancel {
    color: #b42332;
    padding: 12px;
  }
  .pairing-open {
    text-align: center;
    text-decoration: none;
    border-radius: 999px;
  }
  .auth-spinner {
    width: 22px;
    height: 22px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: auth-spin 0.7s linear infinite;
  }
  @keyframes auth-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .creation-progress {
    height: 10px;
    border-radius: 10px;
    overflow: hidden;
    background: #e2e8f0;
  }
  .creation-progress::after {
    content: '';
    display: block;
    height: 100%;
    background: #2563eb;
    animation: progress 2s linear forwards;
  }
  @keyframes progress {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }
</style>
