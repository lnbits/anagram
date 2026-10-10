<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    generateGroupRecoveryPhrase,
    makeGroupRecoveryBackup,
  } from '#src/stores/nostr/groupRecovery.ts';
  export let phrase = generateGroupRecoveryPhrase();
  export let relayUrls: string[] = [];
  export let busy = false;
  export let confirmLabel = 'Create group';
  export let onverified: (phrase: string) => void | Promise<void>;
  let step: 'backup' | 'verify' = 'backup';
  let saved = false;
  let answers = ['', '', ''];
  let positions: number[] = [];
  let error = '';
  let url = '';
  $: words = phrase.split(' ');
  function download() {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(
      new Blob([JSON.stringify(makeGroupRecoveryBackup(phrase, relayUrls), null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `anagram-group-${makeGroupRecoveryBackup(phrase, relayUrls).group_pubkey.slice(0, 12)}-PRIVATE.json`;
    document.body.append(link);
    link.click();
    link.remove();
  }
  function verify() {
    const indexes = Array.from({ length: 12 }, (_, i) => i);
    for (let i = indexes.length - 1; i > 0; i--) {
      // Random questions are a usability check, not a cryptographic secret.
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    positions = indexes.slice(0, 3).sort((a, b) => a - b);
    answers = ['', '', ''];
    error = '';
    step = 'verify';
  }
  async function confirm() {
    if (positions.some((position, i) => answers[i].trim().toLowerCase() !== words[position])) {
      error = 'Those words do not match. Check your backup and try again.';
      return;
    }
    error = '';
    await onverified(phrase);
  }
  onDestroy(() => {
    if (url) URL.revokeObjectURL(url);
    phrase = '';
    answers = [];
  });
</script>

<section class="seed-backup" aria-label="Group recovery backup">
  <p class="steps">{step === 'backup' ? '1 · Back up' : '2 · Verify backup'}</p>
  {#if step === 'backup'}
    <h3>Keep your group recoverable</h3>
    <p>
      These 12 words restore ownership and your group’s message keys. Anyone with a copy can manage
      the group and read its available history. We recommend one owner per group. Keep these words
      private to avoid conflicting changes.
    </p>
    <ol class="words" aria-label="Recovery words">
      {#each words as word, i}<li><span>{i + 1}</span><strong>{word}</strong></li>{/each}
    </ol>
    <button class="outline" onclick={download} disabled={busy}>Download private backup</button>
    <p class="hint">
      Store the file securely or write the words down in order. This is a group backup, not your
      account key.
    </p>
    <label class="saved"
      ><input type="checkbox" bind:checked={saved} disabled={busy} />I have saved my recovery words
      somewhere safe</label
    >
    <button class="primary next" disabled={!saved || busy} onclick={verify}>Verify backup</button>
  {:else}
    <h3>Check your saved words</h3>
    <p>Enter these words from your backup.</p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
      autocomplete="off"
    >
      <div class="verification-words">
        {#each positions as position, i}
          <label
            >Word {position + 1}<input
              bind:value={answers[i]}
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              disabled={busy}
            /></label
          >
        {/each}
      </div>
      {#if error}<p role="alert" class="error">{error}</p>{/if}
      <div class="actions">
        <button
          type="button"
          class="outline"
          disabled={busy}
          onclick={() => {
            step = 'backup';
            answers = ['', '', ''];
          }}>Back</button
        >
        <button class="primary" type="submit" disabled={busy || answers.some((a) => !a.trim())}
          >{busy ? 'Working…' : confirmLabel}</button
        >
      </div>
    </form>
  {/if}
</section>

<style>
  .seed-backup {
    max-width: 480px;
    margin: 0 auto;
  }
  .steps {
    color: var(--q-primary);
    font-size: 12px;
    font-weight: 600;
  }
  h3 {
    margin: 12px 0;
  }
  p {
    line-height: 1.5;
  }
  .words {
    list-style: none;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .words li {
    display: flex;
    gap: 8px;
    align-items: center;
    border: 1px solid var(--nc-border);
    border-radius: 8px;
    padding: 12px 8px;
    background: var(--nc-bg);
  }
  .words span {
    color: var(--nc-text-secondary);
    font-size: 11px;
    min-width: 14px;
  }
  .words strong {
    font-size: 14px;
  }
  .hint {
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
  .saved {
    display: flex;
    flex-direction: row;
    align-items: start;
    gap: 10px;
    line-height: 1.5;
    margin: 16px 0;
  }
  .saved input {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    margin: 2px 0;
  }
  .verification-words {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .verification-words label,
  .verification-words input {
    min-width: 0;
  }
  .actions {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  button {
    min-height: 44px;
  }
  .next {
    width: 100%;
  }
  @media (max-width: 480px) {
    .words {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
