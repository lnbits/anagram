<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { parseGroupRecoveryBackup } from '#src/stores/nostr/groupRecovery.ts';
  export let onback: () => void;
  export let onrestored: (group: string) => void | Promise<void>;
  const nostr = useNostrStore();
  let words = Array<string>(12).fill('');
  $: phrase = words.map((word) => word.trim()).join(' ');
  let relayText = '';
  let busy = false;
  let error = '';
  let found: { group: string; name: string; epoch: number; conflict: boolean } | null = null;
  let alive = true;
  let join = false;
  onDestroy(() => {
    alive = false;
    words = Array<string>(12).fill('');
  });
  function pasteWords(event: ClipboardEvent, index: number) {
    const pasted =
      event.clipboardData?.getData('text').normalize('NFKD').trim().toLowerCase().split(/\s+/) ??
      [];
    if (pasted.length <= 1) return;
    event.preventDefault();
    const start = pasted.length === 12 ? 0 : index;
    if (start + pasted.length > 12) {
      error = 'Enter exactly 12 recovery words.';
      return;
    }
    words = words.map((word, i) =>
      i >= start && i < start + pasted.length ? pasted[i - start] : word,
    );
    error = '';
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('The recovery file is too large.');
      const backup = parseGroupRecoveryBackup(await file.text());
      if (!alive) return;
      words = backup.phrase.split(' ');
      relayText = backup.relays.join('\n');
      found = null;
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unable to read the recovery file.';
    }
  }
  async function run(confirm = false) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const urls = relayText.split(/[\s,]+/).filter(Boolean);
      if (!confirm) {
        const preview = await nostr.groupRecovery.inspect(phrase, urls);
        if (!alive) return;
        found = {
          group: preview.group,
          name: preview.heads[0].state.name,
          epoch: Math.max(...preview.heads.map((h) => h.state.epoch)),
          conflict: preview.heads.length > 1,
        };
      } else {
        const secret = await nostr.groupRecovery.restore(phrase, urls);
        if (!alive) return;
        if (join)
          await nostr.publishGroupMemberChanges(
            secret.group_pubkey,
            secret.recovery_state!.members,
          );
        else if (
          !found?.conflict &&
          secret.recovery_state!.members.includes(nostr.getLoggedInPublicKeyHex()!)
        ) {
          await nostr.sendGroupEpochTicket(secret.group_pubkey, nostr.getLoggedInPublicKeyHex()!);
        }
        await onrestored(secret.group_pubkey);
      }
    } catch (e) {
      if (alive) error = e instanceof Error ? e.message : 'Recovery failed. Please retry.';
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<section aria-label="Restore private group">
  <p>
    Use the group’s recovery words to recover ownership and available history. We recommend one
    owner per group; sharing these words gives someone permanent co-owner access.
  </p>
  {#if !found}
    <label
      >Recovery file<input
        type="file"
        accept=".json,application/json"
        disabled={busy}
        onchange={(event) => importFile(event.currentTarget.files?.[0])}
      /></label
    >
    <fieldset class="recovery-words">
      <legend>12 recovery words</legend>
      <div class="word-grid">
        {#each words as _, i}
          <label
            ><span>{i + 1}</span><input
              aria-label={`Word ${i + 1}`}
              bind:value={words[i]}
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              disabled={busy}
              onpaste={(event) => pasteWords(event, i)}
            /></label
          >
        {/each}
      </div>
    </fieldset>
    <label
      >Group relays (optional)<textarea
        rows="2"
        bind:value={relayText}
        placeholder="wss://relay.example.com"
        disabled={busy}></textarea></label
    >
    <button class="outline" disabled={busy} onclick={onback}>Back</button>
    <button
      class="primary"
      disabled={busy || words.some((word) => !word.trim())}
      onclick={() => run()}>Find group</button
    >
  {:else}
    <h4>{found.name || 'Private group'}</h4>
    <p class="key">{nostr.encodeNpub(found.group)}</p>
    <p>
      Found history through epoch {found.epoch}. Messages load from available relays after
      restoration.
    </p>
    {#if found.conflict}<p>
        Owners made conflicting updates. Restore access, then reconcile them in the group’s Recovery
        tab.
      </p>{/if}
    <label class="join"
      ><input type="checkbox" bind:checked={join} disabled={busy || found.conflict} />Join this
      group with my signed-in account</label
    >
    <button class="outline" disabled={busy} onclick={() => (found = null)}>Back</button>
    <button class="primary" disabled={busy} onclick={() => run(true)}>Restore ownership</button>
  {/if}
  {#if busy}<p role="status">Checking encrypted group recovery records…</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</section>

<style>
  section {
    max-width: 480px;
  }
  p {
    line-height: 1.5;
  }
  .recovery-words {
    border: 0;
    margin: 16px 0;
    padding: 0;
    min-width: 0;
  }
  legend {
    margin-bottom: 8px;
  }
  .word-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .word-grid label {
    position: relative;
    display: block;
    margin: 0;
    min-width: 0;
  }
  .word-grid span {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--nc-text-secondary);
    font-size: 11px;
    pointer-events: none;
  }
  .word-grid input {
    min-width: 0;
    padding-left: 34px;
    margin: 0;
  }
  @media (max-width: 480px) {
    .word-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .key {
    overflow-wrap: anywhere;
    font-size: 12px;
    color: var(--nc-text-secondary);
  }
  button {
    min-height: 44px;
    margin: 8px 8px 0 0;
  }
  .join {
    display: flex;
    flex-direction: row;
    gap: 10px;
    align-items: center;
  }
  .join input {
    width: 18px;
    height: 18px;
  }
</style>
