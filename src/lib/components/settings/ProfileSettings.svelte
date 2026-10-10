<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { autosizeTextarea } from '#src/lib/actions/autosizeTextarea.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { translate } from '#src/i18n.ts';
  import { Notify } from '#src/lib/platform/ui.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { NostrPrivateKeySigner, nip19 } from '#src/lib/nostr/client.ts';
  import { AUTH_METHOD_STORAGE_KEY, PRIVATE_KEY_STORAGE_KEY } from '#src/stores/nostr/constants.ts';
  import { useRelayStore } from '#src/stores/relayStore.ts';
  import { contactsService } from '#src/services/contactsService.ts';
  import { createEmptyContactProfileForm } from '#src/types/contactProfile.ts';
  import { buildContactProfilePublishPayload } from '#src/utils/contactProfilePublish.ts';
  import Icon from '../Icon.svelte';
  import ImageUrlField from '../ImageUrlField.svelte';
  let pictureUploading = false,
    bannerUploading = false;
  $: imageUploading = pictureUploading || bannerUploading;
  const nostr = useNostrStore(),
    relays = useRelayStore();
  const pubkey = nostr.getLoggedInPublicKeyHex() ?? '',
    npub = nostr.encodeNpub(pubkey);
  let dirty = false,
    mounted = false;
  const profileVersion = observe(() => nostr.contactListVersion);
  $: if (mounted && !dirty && $profileVersion >= 0) void load();
  let form = createEmptyContactProfileForm(),
    busy = true,
    ready = false,
    error = '',
    notice = '',
    hex = false,
    qr = '';
  let shareDialog: HTMLDialogElement;
  let localKeyAvailable = false,
    copyingPrivateKey = false;
  const fields = [
    ['name', 'common.name'],
    ['about', 'common.about'],
    ['picture', 'profile.pictureUrl'],
    ['nip05', 'NIP-05'],
    ['lud16', 'common.lightningAddress'],
    ['lud06', 'LNURL'],
  ] as const;
  const extra = [
    ['display_name', 'profile.alternativeDisplayName'],
    ['website', 'profile.website'],
    ['banner', 'profile.bannerUrl'],
  ] as const;
  async function load(refresh = false) {
    busy = true;
    error = '';
    notice = '';
    try {
      if (refresh) await nostr.refreshContactByPublicKey(pubkey);
      const contact = await contactsService.getContactByPublicKey(pubkey);
      const next = createEmptyContactProfileForm();
      if (contact) {
        for (const [key] of [...fields, ...extra])
          next[key] = String(
            contact.meta[key] ??
              (key === 'name'
                ? contact.name
                : key === 'display_name'
                  ? (contact.given_name ?? '')
                  : ''),
          );
        next.bot = contact.meta.bot === true;
        next.group = contact.meta.group === true;
        next.birthday = {
          year: contact.meta.birthday?.year ?? null,
          month: contact.meta.birthday?.month ?? null,
          day: contact.meta.birthday?.day ?? null,
        };
        next.relays = (contact.relays ?? []).map((r) => r.url);
      }
      form = next;
      ready = true;
    } catch {
      error = $translate('profile.profileCheckFailed');
    } finally {
      busy = false;
    }
  }
  async function publish() {
    if (busy || !ready || imageUploading) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await nostr.publishUserMetadata(buildContactProfilePublishPayload(form), relays.relays);
      notice = $translate('profile.profileMetadataPublished');
    } catch {
      error = 'Could not publish your profile. Please try again.';
    } finally {
      busy = false;
    }
  }
  async function share() {
    error = '';
    try {
      const QR = await import('qrcode');
      qr = await QR.toDataURL(`nostr:${npub}`, { width: 300, margin: 2 });
      shareDialog.showModal();
    } catch {
      error = 'Could not create profile QR code.';
    }
  }
  async function copy(value = hex ? pubkey : npub) {
    try {
      await navigator.clipboard.writeText(value);
      Notify.create({
        message: $translate('common.copiedLabel', { label: $translate('contacts.publicKey') }),
      });
    } catch {
      Notify.create({ type: 'negative', message: 'Could not copy the public key.' });
    }
  }
  async function copyPrivateKey() {
    if (copyingPrivateKey) return;
    copyingPrivateKey = true;
    // Feedback never includes the key itself.
    const fail = (message: string) => Notify.create({ type: 'negative', message });
    try {
      const stored = localStorage.getItem(PRIVATE_KEY_STORAGE_KEY)?.trim();
      if (!stored || localStorage.getItem(AUTH_METHOD_STORAGE_KEY) !== 'nsec') {
        fail('No private key is stored locally for this account.');
        return;
      }
      const signer = new NostrPrivateKeySigner(stored);
      if (signer.pubkey !== pubkey || signer.pubkey !== nostr.getLoggedInPublicKeyHex()) {
        fail('The stored private key does not match this account.');
        return;
      }
      await navigator.clipboard.writeText(nip19.nsecEncode(signer.secretKey));
      Notify.create({ message: 'Private key copied.' });
    } catch {
      fail('Could not copy the private key.');
    } finally {
      copyingPrivateKey = false;
    }
  }
  onMount(() => {
    mounted = true;
    localKeyAvailable =
      localStorage.getItem(AUTH_METHOD_STORAGE_KEY) === 'nsec' &&
      Object.hasOwn(localStorage, PRIVATE_KEY_STORAGE_KEY);
  });
</script>

<div class="profile-settings" oninput={() => (dirty = true)}>
  <div class="settings-actions end profile-toolbar">
    <button class="outline" data-testid="contact-profile-share-button" onclick={share}
      >{$translate('common.share')}</button
    ><button
      class="primary"
      data-testid="contact-profile-publish-button"
      disabled={busy || !ready || imageUploading}
      onclick={publish}>{$translate('common.publishAction')}</button
    >
  </div>
  <div class="profile-public-key">
    <button
      class="profile-key-format"
      aria-label={$translate(hex ? 'contacts.showPublicKeyNpub' : 'contacts.showPublicKeyHex')}
      onclick={() => (hex = !hex)}>{hex ? 'NPUB' : 'HEX'}</button
    >
    <div>
      <small>{$translate(hex ? 'contacts.publicKeyHex' : 'contacts.publicKeyNpub')}</small>
      <div class="settings-key">{hex ? pubkey : npub}</div>
    </div>
    <button class="icon-button" aria-label={$translate('common.copy')} onclick={() => copy()}
      ><Icon name="content_copy" /></button
    >
  </div>
  {#if localKeyAvailable}
    <div class="settings-actions">
      <button class="outline" disabled={copyingPrivateKey} onclick={copyPrivateKey}
        >Copy private key</button
      >
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p role="status">
      {notice}
    </p>{/if}
  <div class="profile-sections">
    <details open>
      <summary>{$translate('profile.userMetadataNip01')}</summary>
      <div class="profile-fields">
        {#each fields as [key, label]}{#if key === 'picture'}
            <ImageUrlField
              label={$translate(label)}
              bind:value={form.picture}
              bind:uploading={pictureUploading}
              disabled={busy}
              compact
              testId="profile-picture"
              contextKey={pubkey}
              onchange={() => (dirty = true)}
            />
          {:else}<label class="profile-field" class:filled={!!form[key]}
              ><span>{$translate(label)}</span>{#if key === 'about'}<textarea
                  bind:value={form[key]}
                  use:autosizeTextarea={form[key]}
                  disabled={busy}
                  rows="1"></textarea>{:else}<input
                  bind:value={form[key]}
                  disabled={busy}
                  data-testid={`profile-${key}`}
                  spellcheck="false"
                />{/if}</label
            >{/if}{/each}
      </div>
    </details>
    <details>
      <summary>{$translate('profile.extraMetadataFieldsNip24')}</summary>
      <div class="profile-fields">
        {#each extra as [key, label]}{#if key === 'banner'}
            <ImageUrlField
              label={$translate(label)}
              kind="banner"
              bind:value={form.banner}
              bind:uploading={bannerUploading}
              disabled={busy}
              compact
              testId="profile-banner"
              contextKey={pubkey}
              onchange={() => (dirty = true)}
            />
          {:else}<label class="profile-field" class:filled={!!form[key]}
              ><span>{$translate(label)}</span><input
                bind:value={form[key]}
                disabled={busy}
                data-testid={`profile-${key}`}
              /></label
            >{/if}{/each}
        <label class="settings-switch"
          ><span
            >{$translate('profile.bot')}<small
              >{$translate('common.contentPartiallyFullyAutomated')}</small
            ></span
          ><input
            type="checkbox"
            role="switch"
            aria-label={$translate('profile.bot')}
            bind:checked={form.bot}
            disabled={busy}
          /></label
        ><label class="settings-switch"
          ><span
            >{$translate('group.group')}<small
              >{$translate('group.profileRepresentsGroupIdentity')}</small
            ></span
          ><input
            type="checkbox"
            role="switch"
            aria-label={$translate('group.group')}
            bind:checked={form.group}
            disabled={busy}
          /></label
        >
        <h4>{$translate('profile.birthday')}</h4>
        <div class="profile-birthday">
          {#each ['year', 'month', 'day'] as part}<label
              class="profile-field"
              class:filled={!!form.birthday[part as keyof typeof form.birthday]}
              ><span>{$translate(`common.${part}`)}</span><input
                type="number"
                min="1"
                max={part === 'month' ? 12 : part === 'day' ? 31 : 9999}
                value={form.birthday[part as keyof typeof form.birthday] ?? ''}
                disabled={busy}
                oninput={(e) =>
                  (form.birthday[part as keyof typeof form.birthday] = e.currentTarget.value
                    ? Number(e.currentTarget.value)
                    : null)}
              /></label
            >{/each}
        </div>
      </div>
    </details>
    <details>
      <summary
        >{$translate('relays.nip65.title')}
        <button
          class="icon-button"
          aria-label={$translate('relays.editRelays')}
          onclick={() => goto('/settings/relays')}><Icon name="edit" /></button
        ></summary
      >
      <div class="profile-fields">
        {#each form.relays as relay}<div class="settings-key">{relay}</div>{:else}<p>
            {$translate('relays.nip65RelaysConfigured')}
          </p>{/each}
      </div>
    </details>
  </div>
</div>
<dialog
  bind:this={shareDialog}
  class="settings-dialog"
  use:dismissOnBackdrop={() => shareDialog.close()}
>
  <h2>{$translate('common.share')}</h2>
  {#if qr}<img src={qr} alt="Public profile QR code" />{/if}
  <p class="settings-key">{npub}</p>
  <div class="settings-actions">
    <button class="outline" onclick={() => copy(`nostr:${npub}`)}
      >{$translate('common.copy')}</button
    ><button class="primary" onclick={() => shareDialog.close()}
      >{$translate('common.closeDialog')}</button
    >
  </div>
</dialog>
