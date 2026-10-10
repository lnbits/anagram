<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import {
    profileSearchAllowed,
    type ProfileSearchResult,
  } from '#src/stores/nostr/profileSearchRuntime.ts';
  import { getPublicProfile, rememberPublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { contactsService } from '#src/services/contactsService.ts';
  import Avatar from './Avatar.svelte';
  import PublicGroupRow from './PublicGroupRow.svelte';
  import type { PublicRoom } from '#src/stores/nostr/publicGroups.ts';
  export let query = '';
  export let includePublicGroups = false;
  export let joinedAddresses: string[] = [];
  export let ongroup: (room: PublicRoom) => void = () => {};
  let groups: PublicRoom[] = [];
  let groupLoading = false;
  let groupStatus = '';
  $: visibleGroups = groups.filter((room) => !joinedAddresses.includes(room.address));
  export let existingKeys: string[] = [];
  export let excludedMessage = 'search.existingChats';
  export let onselect: (profile: ProfileSearchResult) => void;
  const nostr = useNostrStore();
  let results: ProfileSearchResult[] = [];
  let loading = false;
  let status = '';
  let dismissed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let container: HTMLElement;
  $: schedule(query);
  $: visible = results.filter((result) => !existingKeys.includes(result.publicKey));
  function schedule(value: string) {
    clearTimeout(timer);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    results = [];
    groups = [];
    groupLoading = false;
    groupStatus = '';
    status = '';
    dismissed = false;
    loading = profileSearchAllowed(value);
    if (!loading) return;
    groupLoading = includePublicGroups;
    timer = setTimeout(async () => {
      if (includePublicGroups) {
        void nostr
          .searchPublicGroups(value, current.signal, (rooms) => {
            if (!current.signal.aborted) groups = rooms;
          })
          .then((result) => {
            if (!current.signal.aborted) groupStatus = result;
          })
          .catch(() => {
            if (!current.signal.aborted) groupStatus = 'unavailable';
          })
          .finally(() => {
            if (!current.signal.aborted) groupLoading = false;
          });
      }
      const saved = new Set<string>();
      try {
        const result = await nostr.searchProfiles(value, current.signal, (profiles) => {
          if (current.signal.aborted) return;
          results = profiles;
          for (const profile of profiles) {
            if (!profile.eventId || saved.has(profile.eventId)) continue;
            saved.add(profile.eventId);
            rememberPublicProfile(profile.publicKey, profile, profile.createdAt, profile.eventId);
            const cached = getPublicProfile(profile.publicKey);
            if (cached?.eventId === profile.eventId)
              void contactsService.savePublicProfile(profile.publicKey, cached).catch(() => {});
          }
        });
        if (!current.signal.aborted) status = result;
      } catch {
        if (!current.signal.aborted) status = 'unavailable';
      } finally {
        if (!current.signal.aborted) loading = false;
      }
    }, 260);
  }
  export async function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      dismissed = true;
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (!visible.length && !visibleGroups.length) return;
    event.preventDefault();
    dismissed = false;
    await tick();
    const buttons = [...(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    ]?.focus();
  }
  onDestroy(() => {
    clearTimeout(timer);
    controller?.abort();
  });
</script>

{#if profileSearchAllowed(query) && !dismissed}
  <div bind:this={container} role="group" aria-label={$translate('search.relayResults')}>
    {#if includePublicGroups}
      <section class="profile-search-results" aria-label={$translate('search.publicGroups')}>
        <h2>{$translate('search.publicGroups')}</h2>
        {#each visibleGroups as room (room.address)}
          <PublicGroupRow
            {room}
            testId="public-group-search-result"
            onselect={() => ongroup(room)}
            onkeydown={handleKeydown}
          />
        {/each}
        <p role="status" aria-live="polite">
          {#if groupLoading}{$translate('search.searchingGroups')}
          {:else if groupStatus === 'unavailable'}{$translate('search.groupsUnavailable')}
          {:else if !visibleGroups.length}{groups.length
              ? $translate('search.existingGroups')
              : $translate('search.noGroups')}{/if}
        </p>
      </section>
    {/if}
    <section class="profile-search-results" aria-label={$translate('search.people')}>
      <h2>{$translate('search.people')}</h2>
      {#each visible as profile (profile.publicKey)}
        <button
          class="profile-result"
          data-testid="profile-search-result"
          onclick={() => onselect(profile)}
          onkeydown={handleKeydown}
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
        </button>
      {/each}
      <p role="status" aria-live="polite">
        {#if loading}{$translate('search.searchingProfiles')}
        {:else if status === 'unavailable'}{$translate('search.profilesUnavailable')}
        {:else if !visible.length}{results.length
            ? $translate(excludedMessage)
            : $translate('search.noProfiles')}{/if}
      </p>
    </section>
  </div>
{/if}

<style>
  .profile-search-results {
    border-top: 1px solid var(--nc-border);
    padding: 8px 0;
  }
  h2 {
    font-size: 12px;
    color: var(--nc-text-secondary);
    margin: 4px 12px 8px;
    font-weight: 600;
  }
  .profile-result {
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    width: 100%;
    padding: 9px 12px;
  }
  .profile-result:hover,
  .profile-result:focus-visible {
    background: var(--nc-search-bg);
  }
  .profile-result > span {
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
  small,
  p {
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
  p {
    margin: 6px 12px;
  }
  p:empty {
    display: none;
  }
</style>
