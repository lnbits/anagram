<script lang="ts">
  import { dismissOnOutside } from '#src/lib/actions/dismissOnOutside.ts';
  import { translate } from '#src/i18n.ts';
  import type { ContactRecord } from '#src/types/contact.ts';
  import {
    searchContactsForList,
    contactListTitle,
    contactListCaption,
  } from '#src/utils/contactList.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import Avatar from './Avatar.svelte';
  import ProfileName from './ProfileName.svelte';
  import Icon from './Icon.svelte';
  export let contacts: ContactRecord[];
  export let query = '';
  export let selectedKey = '';
  export let onselect: (contact: ContactRecord) => void;
  export let onaction: (contact: ContactRecord, action: string) => void;
  const nostr = useNostrStore();
  let expanded = { active: true, muted: false, blocked: false };
  let menu = '';
  let menuTrigger: HTMLButtonElement;
  $: options = {
    loggedInPubkey: nostr.getLoggedInPublicKeyHex(),
    resolveNpub: (key: string) => nostr.encodeNpub(key),
  };
  $: matches = searchContactsForList(contacts, query, options);
  $: sections = [
    {
      key: 'active',
      contacts: matches.filter((contact) => !contact.meta.muted && !contact.meta.blocked),
    },
    {
      key: 'muted',
      contacts: matches.filter((contact) => contact.meta.muted && !contact.meta.blocked),
    },
    { key: 'blocked', contacts: matches.filter((contact) => contact.meta.blocked) },
  ];
  $: selected = contacts.find((contact) => contact.public_key === selectedKey);
  $: if (selected)
    expanded = {
      ...expanded,
      [selected.meta.blocked ? 'blocked' : selected.meta.muted ? 'muted' : 'active']: true,
    };
  function action(contact: ContactRecord, action: string) {
    menu = '';
    onaction(contact, action);
  }
</script>

<div data-testid="contacts-list">
  {#each sections as section}
    <button
      class="section-toggle"
      aria-expanded={Boolean(query) || expanded[section.key]}
      onclick={() => (expanded = { ...expanded, [section.key]: !expanded[section.key] })}
    >
      <span
        >{query || expanded[section.key] ? '▾' : '▸'}
        {$translate(`contacts.section.${section.key}`)}</span
      ><small>{section.contacts.length}</small>
    </button>
    {#if query || expanded[section.key]}
      {#each section.contacts as contact (contact.public_key)}
        <div class="contact-row" class:active={selectedKey === contact.public_key}>
          <button
            class="chat-item"
            data-testid="contact-item"
            data-public-key={contact.public_key}
            onclick={() => onselect(contact)}
          >
            <Avatar
              privateGroup={contact.type === 'group'}
              publicKey={contact.public_key}
              name={contactListTitle(contact, options)}
              picture={contact.meta.picture ?? ''}
              fontSize={14}
            />
            <span class="chat-copy"
              ><strong
                >{#if contact.public_key === options.loggedInPubkey}{contactListTitle(
                    contact,
                    options,
                  )}{:else}<ProfileName
                    publicKey={contact.public_key}
                    givenName={contact.given_name ?? ''}
                    fallback={contactListTitle(contact, options)}
                  />{/if}</strong
              ><small>{contactListCaption(contact, options)}</small></span
            >
            {#if contact.meta.blocked}<span aria-label={$translate('common.block')}>⊘</span
              >{:else if contact.meta.muted}<span aria-label={$translate('common.mute')}>♩</span
              >{/if}
          </button>
          <button
            class="icon-button contact-menu"
            aria-label={$translate('contacts.contactActions')}
            aria-expanded={menu === contact.public_key}
            onclick={(event) => {
              menuTrigger = event.currentTarget;
              menu = menu === contact.public_key ? '' : contact.public_key;
            }}><Icon name="more" /></button
          >
          {#if menu === contact.public_key}<div
              use:dismissOnOutside={{ dismiss: () => (menu = ''), trigger: menuTrigger }}
              class="contact-actions"
              role="menu"
              tabindex="-1"
            >
              {#if !contact.meta.blocked}
                <button role="menuitem" onclick={() => action(contact, 'chat')}
                  >{$translate('chat.chat')}</button
                >
                <button role="menuitem" onclick={() => action(contact, 'refresh')}
                  >{$translate('profile.refreshProfile')}</button
                >
                <button
                  role="menuitem"
                  onclick={() => action(contact, contact.meta.muted ? 'unmute' : 'mute')}
                  >{$translate(contact.meta.muted ? 'common.unmute' : 'common.mute')}</button
                >
                <button role="menuitem" class="danger-text" onclick={() => action(contact, 'block')}
                  >{$translate('common.block')}</button
                >
              {:else}<button role="menuitem" onclick={() => action(contact, 'unblock')}
                  >{$translate('common.unblock')}</button
                >{/if}
              <button role="menuitem" class="danger-text" onclick={() => action(contact, 'delete')}
                >{$translate('contacts.deleteContact')}</button
              >
            </div>{/if}
        </div>
      {/each}
    {/if}
  {/each}
  {#if !matches.length}<p class="empty">{$translate('contacts.contactsFound')}</p>{/if}
</div>

<style>
  .section-toggle {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 12px 16px;
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
  .contact-row {
    position: relative;
    display: flex;
    align-items: center;
    padding-right: 34px;
  }
  .contact-row.active {
    background: var(--nc-active);
  }
  .contact-row.active > .chat-item {
    color: var(--nc-active-text);
  }
  .chat-item {
    min-width: 0;
    gap: 10px;
    padding: 12px;
  }
  .chat-copy {
    min-width: 0;
  }
  .chat-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--nc-text-secondary);
  }
  .contact-row.active .chat-copy small {
    color: var(--nc-active-subtext);
  }
  .contact-menu {
    position: absolute;
    right: 3px;
    width: 30px;
  }
  .contact-actions {
    position: absolute;
    right: 8px;
    top: 48px;
    z-index: 20;
    min-width: 180px;
    padding: 6px;
    border: 1px solid var(--nc-border);
    border-radius: 10px;
    box-shadow: var(--nc-shadow-md);
    background: var(--nc-menu-bg);
    color: var(--nc-text);
  }
  .contact-actions button {
    display: block;
    width: 100%;
    padding: 10px;
    text-align: left;
  }
  .contact-actions button:hover {
    background: var(--nc-hover);
  }
  .empty {
    padding: 20px;
    color: var(--nc-text-secondary);
    font-size: 13px;
  }
</style>
