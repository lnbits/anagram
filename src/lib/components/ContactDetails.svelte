<script lang="ts">
  import ProtocolSpecButton from './ProtocolSpecButton.svelte';
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { onMount } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { contactsService } from '#src/services/contactsService.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import type { ContactRecord } from '#src/types/contact.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import GroupDetails from './GroupDetails.svelte';
  import RelayInfo from './settings/RelayInfo.svelte';
  export let publicKey: string;
  export let onopen: (contact: ContactRecord) => Promise<void>;
  export let onback: (() => void) | undefined = undefined;
  const nostr = useNostrStore();
  const version = observe(() => nostr.contactListVersion);
  $: publicProfile = observePublicProfile(publicKey);
  let contact: ContactRecord | null = null;
  let mounted = false,
    loading = true,
    refreshing = false,
    saving = false,
    hex = false;
  let error = '',
    notice = '',
    qr = '';
  let shareDialog: HTMLDialogElement;
  let revision = 0;
  let infos: Record<string, unknown> = {};
  let infoLoading: Record<string, boolean> = {};
  const fields = [
    ['name', 'common.name'],
    ['about', 'common.about'],
    ['picture', 'profile.pictureUrl'],
    ['nip05', 'NIP-05'],
    ['lud16', 'common.lightningAddress'],
    ['lud06', 'LNURL'],
  ] as const;
  const extra = [
    ['display_name', 'profile.displayName'],
    ['website', 'profile.website'],
    ['banner', 'profile.bannerUrl'],
  ] as const;
  $: name = contact?.given_name || $publicProfile?.name || contact?.name || publicKey.slice(0, 16);
  $: npub = nostr.encodeNpub(publicKey);
  $: shareAddress = `nostr:${contact?.meta.nprofile || npub}`;
  $: if (mounted && $version >= 0) void load();
  async function load() {
    const request = ++revision;
    try {
      const next = await contactsService.getContactByPublicKey(publicKey);
      if (mounted && request === revision) contact = next;
    } catch {
      if (mounted) error = 'Could not load contact details.';
    } finally {
      if (mounted && request === revision) loading = false;
    }
  }
  async function refresh() {
    if (refreshing || contact?.meta.blocked) return;
    refreshing = true;
    error = '';
    try {
      await nostr.refreshContactByPublicKey(publicKey, contact?.name ?? '', {
        refreshRelayList: true,
      });
      await load();
    } catch {
      if (mounted) error = 'Could not refresh this profile. Cached details are still available.';
    } finally {
      refreshing = false;
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notice = $translate('common.copiedLabel', { label: $translate('contacts.publicKey') });
    } catch {
      error = 'Could not copy the public key.';
    }
  }
  async function share() {
    try {
      const QRCode = await import('qrcode');
      qr = await QRCode.toDataURL(shareAddress, { width: 280, margin: 1 });
      if (mounted) shareDialog.showModal();
    } catch {
      error = 'Could not create the contact QR code.';
    }
  }
  async function info(url: string, force = false) {
    if (infoLoading[url] || (!force && infos[url])) return;
    infoLoading = { ...infoLoading, [url]: true };
    try {
      infos = {
        ...infos,
        [url]: (await nostr.fetchRelayNip11Info(url, force)) ?? 'No NIP-11 information available.',
      };
    } catch {
      infos = { ...infos, [url]: 'Could not load relay information.' };
    } finally {
      infoLoading = { ...infoLoading, [url]: false };
    }
  }
  onMount(() => {
    mounted = true;
    void load().then(() => {
      if (mounted && !contact?.meta.blocked) void refresh();
    });
    return () => {
      mounted = false;
      revision++;
    };
  });
</script>

<div class="contact-details" data-testid="contact-details" data-public-key={publicKey}>
  <header>
    {#if onback}<button
        class="icon-button contact-back"
        aria-label={$translate('contacts.backContacts')}
        onclick={onback}><Icon name="back" /></button
      >{/if}
    <button
      class="identity"
      disabled={!contact || contact.meta.blocked}
      onclick={() => contact && onopen(contact)}
    >
      <Avatar
        privateGroup={contact?.type === 'group'}
        {publicKey}
        {name}
        picture={contact?.meta.picture ?? ''}
        eager
      />
      <span
        ><strong>{name}</strong><small
          >{contact?.type === 'group'
            ? 'Private group'
            : $translate('contacts.contactProfile')}</small
        ></span
      >
    </button>
    <button
      class="icon-button"
      aria-label={$translate('chat.openChat')}
      disabled={!contact || contact.meta.blocked}
      onclick={() => contact && onopen(contact)}><Icon name="chat" /></button
    >
  </header>
  <div class="detail-body">
    <div class="actions">
      {#if !loading}<ProtocolSpecButton
          kind={contact?.type === 'group' ? 'private' : 'direct'}
        />{/if}
      <button
        class="outline"
        data-testid="contact-profile-refresh-button"
        disabled={refreshing || contact?.meta.blocked}
        onclick={refresh}>{refreshing ? 'Refreshing…' : $translate('common.refresh')}</button
      >
      <button class="outline" data-testid="contact-profile-share-button" onclick={share}
        >{$translate('common.share')}</button
      >
    </div>
    <div class="public-key">
      <button
        class="outline"
        aria-label={hex
          ? $translate('contacts.showPublicKeyNpub')
          : $translate('contacts.showPublicKeyHex')}
        onclick={() => (hex = !hex)}>{hex ? 'HEX' : 'NPUB'}</button
      >
      <label
        >{hex ? $translate('contacts.publicKeyHex') : $translate('contacts.publicKeyNpub')}<input
          readonly
          value={hex ? publicKey : npub}
        /></label
      >
      <button
        class="icon-button"
        aria-label={$translate('common.copy')}
        onclick={() => copy(hex ? publicKey : npub)}><Icon name="content_copy" /></button
      >
    </div>
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if loading}<p>{$translate('contacts.loadingContacts')}</p>
    {:else if !contact}<p>{$translate('contacts.contactFoundPublicKey')}</p>
    {:else}
      {#if contact.type === 'group'}<GroupDetails {publicKey} />{/if}
      <details open class="profile-section">
        <summary>{$translate('profile.userMetadataNip01')}</summary>
        <div class="fields">
          {#each fields as [key, label]}<label
              >{$translate(label)}
              {#if key === 'about'}<textarea
                  readonly
                  rows="3"
                  value={String(contact.meta[key] ?? '')}></textarea>
              {:else}<input
                  readonly
                  value={String(contact.meta[key] ?? (key === 'name' ? contact.name : ''))}
                />{/if}
            </label>{/each}
        </div>
      </details>
      {#if contact.type !== 'group'}<details class="profile-section">
          <summary>{$translate('profile.extraMetadataFieldsNip24')}</summary>
          <div class="fields">
            {#each extra as [key, label]}<label
                >{$translate(label)}<input
                  readonly
                  value={String(contact.meta[key] ?? '')}
                /></label
              >{/each}
            <label class="switch"
              ><span>{$translate('profile.bot')}</span><input
                type="checkbox"
                role="switch"
                checked={contact.meta.bot === true}
                disabled
              /></label
            >
            <div class="birthday">
              {#each ['year', 'month', 'day'] as part}<label
                  >{$translate(`common.${part}`)}<input
                    readonly
                    value={contact.meta.birthday?.[part] ?? ''}
                  /></label
                >{/each}
            </div>
          </div>
        </details>{/if}
      <details class="profile-section">
        <summary>{$translate('relays.nip65.title')}</summary>
        <div class="fields">
          {#each contact.relays ?? [] as relay (relay.url)}<details
              class="relay"
              ontoggle={(event) => {
                if (event.currentTarget.open) void info(relay.url);
              }}
            >
              <summary>{relay.url}</summary>
              <div class="relay-flags">
                <label>Read<input type="checkbox" disabled checked={relay.read} /></label><label
                  >Write<input type="checkbox" disabled checked={relay.write} /></label
                >
              </div>
              {#if infoLoading[relay.url]}<p>
                  Loading relay information…
                </p>{:else if infos[relay.url]}<RelayInfo value={infos[relay.url]} />{/if}
              <button class="outline" onclick={() => info(relay.url, true)}
                >Retry relay information</button
              >
            </details>{:else}<p>{$translate('relays.relaysConfigured')}</p>{/each}
        </div>
      </details>
    {/if}
  </div>
</div>
<dialog
  bind:this={shareDialog}
  use:dismissOnBackdrop={() => shareDialog.close()}
  aria-label={$translate('contacts.shareContact')}
>
  <button
    class="icon-button share-close"
    aria-label="Close share dialog"
    onclick={() => shareDialog.close()}><Icon name="close" /></button
  >
  <h2>{$translate('contacts.shareContact')}</h2>
  {#if qr}<img
      src={qr}
      alt={$translate('contacts.qrCodeContactNostr')}
      width="280"
      height="280"
    />{/if}
  <p class="share-address">{shareAddress}</p>
  <button class="primary" onclick={() => copy(shareAddress)}>{$translate('common.copy')}</button>
</dialog>

<style>
  .contact-details {
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--nc-border);
    background: var(--nc-panel-header-bg);
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    text-align: left;
    min-width: 0;
  }
  .identity span {
    display: grid;
    gap: 4px;
  }
  small {
    display: block;
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
  .detail-body {
    max-width: 1000px;
    margin: auto;
    padding: 20px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
    margin-bottom: 18px;
  }
  .public-key {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  label {
    display: grid;
    gap: 6px;
    min-width: 0;
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
  .public-key label {
    flex: 1;
  }
  input:not([type='checkbox']),
  textarea {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    border: 1px solid var(--nc-border);
    border-radius: 18px;
    color: var(--nc-text);
    padding: 10px 14px;
    font: inherit;
    font-size: 14px;
  }
  .profile-section {
    border: 1px solid var(--nc-border);
    border-radius: 16px;
    margin: 14px 0;
    overflow: hidden;
  }
  summary {
    cursor: pointer;
    padding: 15px;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .fields {
    display: grid;
    gap: 15px;
    padding: 0 16px 18px;
  }
  .switch {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
  }
  .birthday {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .relay {
    border-top: 1px solid var(--nc-border);
  }
  .relay-flags {
    display: flex;
    gap: 24px;
    margin: 12px;
  }
  .contact-back {
    display: none;
  }
  dialog {
    max-width: min(440px, 90vw);
    text-align: center;
    border: 1px solid var(--nc-border);
    border-radius: 18px;
    background: var(--nc-panel-header-bg);
    color: var(--nc-text);
    padding: 24px;
  }
  dialog::backdrop {
    background: #0008;
  }
  .share-close {
    float: right;
  }
  .share-address {
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  @media (max-width: 767px) {
    .contact-back {
      display: inline-flex;
    }
    .detail-body {
      padding: 14px;
    }
  }
</style>
