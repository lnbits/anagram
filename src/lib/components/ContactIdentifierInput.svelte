<script lang="ts">
  import { tick } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { nip19 } from '#src/lib/nostr/client.ts';
  import type { ProfileSearchResult } from '#src/stores/nostr/profileSearchRuntime.ts';
  import ProfileSearchResults from './ProfileSearchResults.svelte';
  import Icon from './Icon.svelte';
  import NpubScanner from './NpubScanner.svelte';
  export let value = '';
  export let disabled = false;
  export let existingKeys: string[] = [];
  export let searchReady = true;
  export let onselect: (profile: ProfileSearchResult) => void = () => {};
  let search: ProfileSearchResults | undefined;
  let selectedValue = '';
  function select(profile: ProfileSearchResult) {
    if (disabled || existingKeys.includes(profile.publicKey)) return;
    selectedValue = nip19.npubEncode(profile.publicKey);
    value = selectedValue;
    onselect(profile);
    void focusInput();
  }
  async function focusInput() {
    await tick();
    input?.focus();
    input?.setSelectionRange(0, 0);
    if (input) input.scrollLeft = 0;
  }
  let scanning = false;
  let input: HTMLInputElement;
  let scanButton: HTMLButtonElement;
  async function scanned(npub: string) {
    value = npub;
    scanning = false;
    await focusInput();
  }
  async function cancel() {
    scanning = false;
    await tick();
    scanButton?.focus();
  }
</script>

<label class="identifier-label" for="contact-identifier"
  >{$translate('contacts.identifierLabel')}</label
>
<div class="identifier-field">
  <input
    id="contact-identifier"
    bind:this={input}
    bind:value
    {disabled}
    placeholder={$translate('contacts.identifierPlaceholder')}
    data-testid="contact-identifier-input"
    spellcheck="false"
    autocapitalize="none"
    autocomplete="off"
    onkeydown={(event) => search?.handleKeydown(event)}
  />
  <button
    bind:this={scanButton}
    class="icon-button"
    type="button"
    aria-label={$translate('qr.scanNpub')}
    aria-expanded={scanning}
    title={$translate('qr.scanNpub')}
    disabled={disabled || scanning}
    onclick={() => (scanning = true)}><Icon name="qr-scan" /></button
  >
</div>
{#if scanning}<NpubScanner onscan={scanned} oncancel={cancel} />
{:else if searchReady && !disabled && value !== selectedValue}
  <div class="identifier-results">
    <ProfileSearchResults
      bind:this={search}
      query={value}
      {existingKeys}
      excludedMessage="search.existingContacts"
      onselect={select}
    />
  </div>
{/if}

<style>
  .identifier-results {
    max-height: min(260px, 30dvh);
    overflow-y: auto;
  }
  .identifier-label {
    margin-bottom: 8px;
  }
  .identifier-field {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .identifier-field input {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .identifier-field button {
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
  }
</style>
