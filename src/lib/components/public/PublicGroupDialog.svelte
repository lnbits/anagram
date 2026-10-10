<script lang="ts">
  import ProtocolSpecButton from '../ProtocolSpecButton.svelte';
  import { Notify } from '#src/lib/platform/ui.ts';
  import GroupProfileFields from '../GroupProfileFields.svelte';
  import DetailTabs from '../DetailTabs.svelte';
  import RelayEditor from '../RelayEditor.svelte';
  import ModalFrame from '../ModalFrame.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import {
    publicGroupShareLink,
    decodeRoomLink,
    type PublicRoom,
  } from '#src/stores/nostr/publicGroups.ts';
  import { previewUrl } from '#src/utils/linkPreview.ts';
  import GroupInviteDialog from '../GroupInviteDialog.svelte';
  import MemberRow from '../MemberRow.svelte';
  import PublicAvatar from './PublicAvatar.svelte';
  let imageUploading = false;
  export let room: PublicRoom | null = null;
  export let onleave: () => void = () => {};
  export let onclose: () => void;
  export let onopen: (link: string) => void;
  const nostr = useNostrStore();
  const runtime = nostr.publicGroups;
  let relayUrl = '';
  let relayUrls = [...(room?.relays ?? [])];
  let loadingRelays = !room;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
  });
  function close() {
    if (!disposed) onclose();
  }

  const reviewedId = room?.event.id;
  let name = room?.name || '',
    about = room?.about || '',
    picture = room?.picture || '';
  let tab = 'Profile',
    busy = false,
    error = '',
    picker: '' | 'trusted' | 'blocked' = '';
  let join = '',
    predecessor = '',
    successor = '',
    confirmTransfer = false,
    confirmLeave = false;
  $: owner = !room || room.owner === nostr.getLoggedInPublicKeyHex();
  async function act(fn: () => Promise<void>) {
    if (busy || imageUploading) return;
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    if (!room)
      void runtime
        .defaultRelays()
        .then((urls) => {
          if (!disposed) relayUrls = urls;
        })
        .catch((cause) => {
          if (!disposed)
            error = cause instanceof Error ? cause.message : 'Could not load default relays.';
        })
        .finally(() => {
          if (!disposed) loadingRelays = false;
        });
  });
  function addRelay() {
    try {
      const url = new URL(relayUrl.trim());
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
      if (relayUrls.length >= 8 && !relayUrls.includes(url.href)) throw new Error();
      if (!relayUrls.includes(url.href)) relayUrls = [...relayUrls, url.href];
      relayUrl = '';
      error = '';
    } catch {
      error = 'Enter a ws:// or wss:// relay URL without credentials. Choose up to 8 relays.';
    }
  }
  async function saveRelays() {
    if (!room) return;
    await runtime.update({ relays: relayUrls }, reviewedId!);
    close();
  }
  async function save() {
    if (picture && !previewUrl(picture)) throw new Error('Use a public HTTPS picture URL.');
    if (room) {
      await runtime.update({ name, about, picture }, reviewedId!);
      close();
    } else {
      const link = await runtime.create({ name, about, picture, predecessor, relays: relayUrls });
      close();
      onopen(link);
    }
  }
  async function members(keys: string[], remove = false) {
    if (!room || !picker) return;
    const existing = room[picker];
    const next = remove
      ? existing.filter((k) => !keys.includes(k))
      : [...new Set([...existing, ...keys])];
    await runtime.update({ [picker]: next }, reviewedId!);
    close();
  }
</script>

{#snippet relayEditor()}
  <p>
    The app uses these preferred relays and your app relays. One relay accepting an update is
    enough.
  </p>
  {#if loadingRelays}<p role="status">Loading relays…</p>{/if}
  <RelayEditor
    entries={relayUrls.map((url) => ({ url, read: true, write: true }))}
    bind:url={relayUrl}
    editable={owner}
    disabled={busy || loadingRelays}
    maximum={8}
    onadd={addRelay}
    onremove={(index) => (relayUrls = relayUrls.filter((_, i) => i !== index))}
  />
  {#if owner}
    {#if room}<p class="hint">
        Changing preferred relays does not copy earlier messages to the new relays.
      </p>{/if}
  {/if}
{/snippet}

<ModalFrame
  title={room ? room.name : 'New public group'}
  label={room ? 'Public group settings' : 'New public group'}
  closeLabel="Close public group dialog"
  {busy}
  onclose={close}
>
  {#if room}<div class="identity">
      <PublicAvatar name={room.name} picture={room.picture} size={48} />
      <div>
        <strong>{room.name}</strong><small
          >Public group · {owner ? 'You own this group' : 'Anyone can read and post'}</small
        >
      </div>
    </div>
    <div class="profile-actions">
      <ProtocolSpecButton kind="public" />
      <button
        class="outline"
        disabled={busy}
        onclick={() =>
          act(async () => {
            await runtime.open(publicGroupShareLink(room!));
            close();
          })}>Refresh</button
      >
      <button
        class="outline"
        onclick={async () => {
          try {
            await navigator.clipboard.writeText(publicGroupShareLink(room!));
            Notify.create({ message: 'Group link copied.' });
          } catch {
            Notify.create({ type: 'negative', message: 'Could not copy the group link.' });
          }
        }}>Copy group link</button
      >
    </div>
    <DetailTabs
      items={['Profile', 'Trusted', 'Blocked', 'Relays', ...(owner ? ['Ownership'] : [])]}
      active={tab}
      label="Public group settings tabs"
      disabled={busy || imageUploading}
      onselect={(value) => (tab = value)}
    />
  {/if}
  {#if tab === 'Profile'}
    {#if owner}<GroupProfileFields
        bind:name
        bind:about
        bind:picture
        bind:uploading={imageUploading}
        disabled={busy}
        contextKey={room?.address ?? 'new'}
        nameLimit={100}
        aboutLimit={2000}
      />
      {#if !room}<details>
          <summary>Preferred relays</summary>
          {@render relayEditor()}
        </details>
        <details>
          <summary>Continue a group from another owner</summary><label
            >Previous group link<input
              bind:value={predecessor}
              placeholder="Group link or naddr"
            /></label
          ><small>The current owner must then sign a transfer to your new group.</small>
        </details>{/if}
      <button
        class="primary"
        disabled={busy || imageUploading || loadingRelays || !relayUrls.length || !name.trim()}
        onclick={() => act(save)}
        >{busy ? 'Saving…' : room ? 'Save group profile' : 'Create public group'}</button
      >
    {:else}<p>{room?.about}</p>{/if}
    {#if room}<div class="leave-group">
        {#if confirmLeave}
          <p>Leave this public group? You can rejoin using its link.</p>
          <button class="outline" disabled={busy} onclick={() => (confirmLeave = false)}
            >Cancel</button
          >
          <button
            class="outline danger"
            disabled={busy}
            onclick={() =>
              act(async () => {
                await runtime.leave(room!.address);
                close();
                onleave();
              })}>Leave group</button
          >
        {:else}
          <button class="outline danger" disabled={busy} onclick={() => (confirmLeave = true)}
            >Leave public group</button
          >
        {/if}
      </div>{/if}
    {#if !room}<hr />
      <h3>Join an existing public group</h3>
      <label>Group link or naddr<input bind:value={join} /></label><button
        class="outline"
        disabled={!join.trim() || busy}
        onclick={() =>
          act(async () => {
            decodeRoomLink(join);
            close();
            onopen(join);
          })}>Join public group</button
      >{/if}
  {:else if tab === 'Relays'}
    {@render relayEditor()}
    {#if owner}<button
        class="primary"
        disabled={busy || !relayUrls.length}
        onclick={() => act(saveRelays)}>Save group relays</button
      >{/if}
  {:else if tab === 'Trusted' || tab === 'Blocked'}
    {@const list = tab === 'Trusted' ? 'trusted' : 'blocked'}
    <p>
      {list === 'trusted'
        ? 'Trusted people can share links and media. The owner is always trusted.'
        : 'Messages from blocked people are hidden in this client. Public events remain on relays.'}
    </p>
    {#if owner}<button class="outline" disabled={busy} onclick={() => (picker = list)}
        >Add {list === 'trusted' ? 'trusted users' : 'blocked users'}</button
      >{/if}
    {#each room?.[list] || [] as key (key)}<MemberRow
        publicKey={key}
        npub={nostr.encodeNpub(key)}
        allowAvatar={list === 'trusted'}
        >{#if owner}<button
            class="outline"
            disabled={busy}
            onclick={() => {
              picker = list;
              void act(() => members([key], true));
            }}>Remove</button
          >{/if}
      </MemberRow>{:else}<p class="hint">No users in this list.</p>{/each}
  {:else if tab === 'Ownership' && room && owner}
    <p>
      The new owner creates a public group with this group's link as its predecessor. Paste their
      new group link below.
    </p>
    <label>Successor group link<input bind:value={successor} /></label>
    <label class="confirm"
      ><input type="checkbox" bind:checked={confirmTransfer} />Transfer ownership. Their signed
      lists will govern the continuing group.</label
    >
    <button
      class="primary"
      disabled={busy || !successor || !confirmTransfer}
      onclick={() =>
        act(async () => {
          await runtime.update({ successor: decodeRoomLink(successor) }, reviewedId!);
          close();
        })}>Transfer ownership</button
    >
  {/if}
  {#if error}<p class="error" role="alert">
      {error}
    </p>{/if}
</ModalFrame>
{#if picker && !busy && room}<GroupInviteDialog
    title={picker === 'trusted' ? 'Add trusted users' : 'Add blocked users'}
    actionLabel="Add"
    showHistoryOption={false}
    existingKeys={[room.owner, ...room[picker]]}
    oninvite={(keys) => members(keys)}
    onclose={() => (picker = '')}
  />{/if}

<style>
  .hint {
    color: var(--nc-text-secondary);
    font-size: 13px;
  }
  .identity,
  .profile-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin: 16px 0;
  }
  .profile-actions {
    flex-wrap: wrap;
  }
  .leave-group {
    border-top: 1px solid var(--nc-border);
    margin-top: 24px;
    padding-top: 16px;
  }
  .danger {
    color: var(--nc-danger);
  }
  .identity {
    margin: 24px 0 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--nc-border);
  }
  small {
    display: block;
    color: var(--nc-text-secondary);
  }
  .confirm {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .confirm input {
    width: auto;
  }
  .hint,
  p {
    margin-top: 16px;
  }
  .hint {
    color: var(--nc-text-secondary);
  }
  details {
    margin: 16px 0;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--nc-border);
    margin: 24px 0;
  }
</style>
