<script lang="ts">
  import type { Chat } from '#src/types/chat.ts';
  import { translate } from '#src/i18n.ts';
  import ProfileName from './ProfileName.svelte';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  export let requests: Chat[];
  export let onopen: (chat: Chat) => void;
  export let onaction: (chat: Chat, action: string) => void;
  export let onback: () => void;
</script>

<div class="requests-page">
  <header>
    <button class="icon-button mobile-back" aria-label="Back to chats" onclick={onback}
      ><Icon name="back" /></button
    >
    <div>
      <div class="eyebrow">{$translate('chat.inboxReview')}</div>
      <h1>{$translate('chat.requests')}</h1>
      <p>{$translate('contacts.firstContactChatsStay')}</p>
    </div>
    <div class="summary">
      <strong>{requests.length}</strong><small
        >{$translate(requests.length === 1 ? 'chat.pendingChat' : 'chat.pendingChats')}</small
      >
    </div>
  </header>
  <div class="request-list">
    {#each requests as chat (chat.id)}<article
        data-testid="chat-request-item"
        data-chat-public-key={chat.publicKey}
      >
        <button class="request-identity" data-testid="chat-item" onclick={() => onopen(chat)}
          ><Avatar
            privateGroup={chat.type === 'group'}
            publicKey={chat.publicKey}
            name={chat.name}
            picture={String(chat.meta.picture ?? '')}
          /><span
            ><strong
              ><ProfileName
                publicKey={chat.publicKey}
                givenName={String(chat.meta.given_name ?? '')}
                fallback={chat.name}
              /></strong
            ><small>{chat.lastMessage}</small></span
          ></button
        >
        <div class="request-actions">
          <button class="primary" onclick={() => onaction(chat, 'accept')}
            >{$translate('common.accept')}</button
          ><button class="outline" onclick={() => onopen(chat)}>{$translate('common.open')}</button
          ><button class="danger-text" onclick={() => onaction(chat, 'block')}
            >{$translate('common.block')}</button
          ><button class="danger-text" onclick={() => onaction(chat, 'delete')}
            >{$translate('chat.deleteChat')}</button
          >
        </div>
      </article>{:else}<div class="empty">
        <Icon name="chat" />
        <h2>{$translate('chat.pendingRequests.empty')}</h2>
        <p>{$translate('chat.unknownInboundChatsAppear')}</p>
      </div>{/each}
  </div>
</div>

<style>
  .requests-page {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background:
      radial-gradient(circle at top right, rgba(79, 169, 230, 0.12), transparent 34%),
      var(--nc-panel-thread-bg);
  }
  header {
    display: flex;
    gap: 20px;
    padding: 24px 24px 20px;
    border-bottom: 1px solid var(--nc-border);
    background: color-mix(in srgb, var(--nc-panel-header-bg) 92%, white 8%);
  }
  h1 {
    font-size: clamp(28px, 3vw, 36px);
    line-height: 1.05;
    margin: 0;
  }
  .eyebrow {
    margin-bottom: 6px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--nc-text-secondary);
  }
  header p {
    margin: 8px 0 0;
    color: var(--nc-text-secondary);
    font-size: 15px;
  }
  .summary {
    margin-left: auto;
    padding: 14px 16px;
    border: 1px solid var(--nc-border);
    border-radius: 20px;
    text-align: right;
  }
  .summary strong {
    font-size: 28px;
  }
  small {
    display: block;
    color: var(--nc-text-secondary);
  }
  .request-list {
    overflow: auto;
    padding: 20px 24px;
  }
  article {
    border: 1px solid var(--nc-border);
    border-radius: 16px;
    background: var(--nc-panel-header-bg);
    padding: 16px;
    margin-bottom: 12px;
  }
  .request-identity {
    display: flex;
    width: 100%;
    gap: 12px;
    align-items: center;
    text-align: left;
  }
  .request-identity span {
    min-width: 0;
  }
  .request-identity small {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .request-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .empty {
    text-align: center;
    padding: 48px 12px;
    color: var(--nc-text-secondary);
  }
  .empty h2 {
    margin-top: 16px;
    font-size: 20px;
  }
  @media (max-width: 767px) {
    header {
      gap: 8px;
      padding: 16px;
    }
    .summary {
      display: none;
    }
    .request-list {
      padding: 16px;
    }
  }
</style>
