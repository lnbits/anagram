<script lang="ts">
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { onMount } from 'svelte';
  import { portal } from '#src/lib/actions/portal.ts';
  import { contactsService } from '#src/services/contactsService.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useChatStore } from '#src/stores/chatStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { searchContactsForList } from '#src/utils/contactList.ts';
  import type { ContactRecord } from '#src/types/contact.ts';
  import type { ProfileSearchResult } from '#src/stores/nostr/profileSearchRuntime.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import ProfileSearchResults from './ProfileSearchResults.svelte';

  export let title = 'Invite members';
  export let actionLabel = 'Invite';
  export let showHistoryOption = true;
  export let existingKeys: string[] = [];
  export let oninvite: (keys: string[], hideEarlierMessages: boolean) => Promise<void>;
  export let onclose: () => void;
  const nostr = useNostrStore();
  const chats = useChatStore();
  const requests = observe(() => chats.requestChats.flatMap((chat) => [chat.id, chat.publicKey]));
  let contacts: ContactRecord[] = [];
  let query = '';
  let selected: ProfileSearchResult[] = [];
  let submitting = false;
  let hideEarlierMessages = false;
  let error = '';
  let contactError = '';
  let input: HTMLInputElement;
  let contactResults: HTMLElement;
  let relayResults: ProfileSearchResults | undefined;
  $: excluded = [...existingKeys, ...selected.map((profile) => profile.publicKey)];
  $: eligibleContacts = contacts.filter(
    (contact) =>
      contact.type === 'user' &&
      !contact.meta.blocked &&
      !$requests.includes(contact.public_key) &&
      !$requests.includes(contact.meta.chatId ?? '') &&
      !excluded.includes(contact.public_key),
  );
  $: matches = searchContactsForList(eligibleContacts, query.replace(/^nostr:/i, ''), {
    resolveNpub: (key) => nostr.encodeNpub(key),
  }).slice(0, 30);

  onMount(() => {
    let active = true;
    void contactsService
      .listContacts()
      .then((records) => {
        if (active) contacts = records;
      })
      .catch(() => {
        if (active)
          contactError = 'Your contacts could not be loaded. You can still search relays.';
      });
    return () => {
      active = false;
    };
  });
  function showDialog(node: HTMLDialogElement) {
    node.showModal();
    input?.focus();
    return { destroy: () => node.close() };
  }
  function contactProfile(contact: ContactRecord): ProfileSearchResult {
    return {
      publicKey: contact.public_key,
      name: contact.given_name || contact.meta.display_name || contact.meta.name || contact.name,
      picture: contact.meta.picture || '',
      nip05: contact.meta.nip05 || '',
      relayUrls: contact.relays?.map((relay) => relay.url) ?? [],
    };
  }
  function select(profile: ProfileSearchResult) {
    if (submitting || excluded.includes(profile.publicKey)) return;
    selected = [...selected, profile];
    query = '';
    error = '';
    input?.focus();
  }
  async function invite() {
    if (submitting || !selected.length) return;
    submitting = true;
    error = '';
    try {
      await oninvite(
        selected.map((profile) => profile.publicKey),
        hideEarlierMessages,
      );
      onclose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Unable to invite members. Please retry.';
    } finally {
      submitting = false;
    }
  }
</script>

<dialog
  use:portal
  use:showDialog
  aria-label={title}
  {onclose}
  oncancel={(event) => {
    if (submitting) event.preventDefault();
  }}
  use:dismissOnBackdrop={() => {
    if (!submitting) onclose();
  }}
>
  <header>
    <h2>{title}</h2>
    <button
      class="icon-button"
      aria-label="Close invitation dialog"
      disabled={submitting}
      onclick={onclose}><Icon name="close" /></button
    >
  </header>
  <p>Find people by name, or paste an npub or hex public key.</p>
  <label for="group-invite-search">Search people</label>
  <input
    id="group-invite-search"
    bind:this={input}
    bind:value={query}
    placeholder="Name, npub or hex public key"
    autocomplete="off"
    spellcheck="false"
    disabled={submitting}
    onkeydown={(event) => {
      if (event.key === 'ArrowDown' && matches.length) {
        event.preventDefault();
        contactResults?.querySelector<HTMLButtonElement>('button')?.focus();
      } else void relayResults?.handleKeydown(event);
    }}
  />
  {#if selected.length}
    <div class="selected" aria-label="Selected members">
      {#each selected as profile (profile.publicKey)}
        <button
          class="chip"
          aria-label={`Remove ${profile.name} from selection`}
          disabled={submitting}
          onclick={() =>
            (selected = selected.filter((item) => item.publicKey !== profile.publicKey))}
        >
          <Avatar
            publicKey={profile.publicKey}
            name={profile.name}
            picture={profile.picture}
            size={24}
          />
          <span>{profile.name}</span><Icon name="close" />
        </button>
      {/each}
    </div>
  {/if}
  <div class="results" inert={submitting}>
    <section aria-label="Your contacts" bind:this={contactResults}>
      <h3>Your contacts</h3>
      {#each matches as contact (contact.public_key)}
        {@const profile = contactProfile(contact)}
        <button
          class="contact-result"
          data-testid="invite-contact-result"
          onclick={() => select(profile)}
        >
          <Avatar
            publicKey={profile.publicKey}
            name={profile.name}
            picture={profile.picture}
            size={40}
            eager
          />
          <span
            ><strong>{profile.name}</strong><small
              >{profile.nip05 ||
                `${profile.publicKey.slice(0, 12)}…${profile.publicKey.slice(-6)}`}</small
            ></span
          >
          <small class="contact-badge">Contact</small>
        </button>
      {:else}
        <p class="hint">
          {contactError ||
            (query.trim() ? 'No matching contacts.' : 'Search for someone to invite.')}
        </p>
      {/each}
    </section>
    <ProfileSearchResults
      bind:this={relayResults}
      {query}
      existingKeys={[...excluded, ...matches.map((contact) => contact.public_key)]}
      excludedMessage="Matching people are shown above or already in this group."
      onselect={select}
    />
  </div>
  {#if showHistoryOption}<label class="history-option">
      <input
        type="checkbox"
        bind:checked={hideEarlierMessages}
        disabled={submitting}
        aria-describedby="group-invite-history-hint"
      />
      Hide earlier messages from new members
    </label>
    <p id="group-invite-history-hint" class="history-hint">
      Rotates the group keys with these invitations. Existing members keep their history.
    </p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer>
    <button class="outline" disabled={submitting} onclick={onclose}>Cancel</button>
    <button class="primary" disabled={submitting || !selected.length} onclick={invite}>
      {submitting
        ? showHistoryOption
          ? 'Inviting…'
          : 'Saving…'
        : `${actionLabel}${selected.length ? ` (${selected.length})` : ''}`}
    </button>
  </footer>
</dialog>

<style>
  dialog {
    width: min(480px, calc(100vw - 24px));
    max-height: calc(100dvh - 24px);
    margin: auto;
    padding: 20px;
    border: 1px solid var(--nc-border);
    border-radius: 16px;
    background: var(--nc-panel-sidebar-bg);
    color: var(--nc-text);
    overflow: auto;
  }
  dialog::backdrop {
    background: #0008;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
  }
  p,
  small {
    color: var(--nc-text-secondary);
  }
  p {
    font-size: 13px;
  }
  label {
    display: block;
    font-size: 13px;
    margin: 16px 0 8px;
  }
  input {
    width: 100%;
    min-width: 0;
  }
  .history-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .history-option input {
    width: auto;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .history-hint {
    margin: 0 0 16px;
  }
  .results {
    max-height: 40dvh;
    overflow-y: auto;
    margin: 12px 0;
  }
  h3 {
    font-size: 12px;
    color: var(--q-primary);
    margin: 8px 12px;
  }
  .contact-result {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    text-align: left;
    border-radius: 8px;
  }
  .contact-result:hover,
  .contact-result:focus-visible {
    background: var(--nc-search-bg);
  }
  .contact-result > span {
    flex: 1;
    min-width: 0;
  }
  strong,
  small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong {
    font-size: 13px;
  }
  small {
    font-size: 12px;
  }
  .contact-badge {
    color: var(--q-primary);
    font-size: 11px;
  }
  .hint {
    margin: 8px 12px;
  }
  .selected {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    border: 1px solid var(--nc-border);
    border-radius: 20px;
    padding: 5px 8px;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .error {
    color: var(--nc-danger);
    overflow-wrap: anywhere;
  }
  footer {
    margin-top: 16px;
  }
</style>
