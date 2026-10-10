<script lang="ts">
  import { diagnosticJson, diagnosticText } from '#src/utils/diagnosticExport.ts';
  import { onMount } from 'svelte';
  import DiagnosticFields from './DiagnosticFields.svelte';
  import { translate } from '#src/i18n.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useAppUpdateStore } from '#src/stores/appUpdateStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import type {
    DeveloperDiagnosticsSnapshot,
    DeveloperTraceEntry,
  } from '#src/stores/nostr/types.ts';
  const nostr = useNostrStore(),
    update = useAppUpdateStore();
  const state = observe(() => ({
    enabled: nostr.developerDiagnosticsEnabled,
    version: nostr.developerDiagnosticsVersion,
    trace: nostr.developerTraceVersion,
    startup: nostr.startupSteps,
    restoring: nostr.isRestoringStartupState,
  }));
  let snapshot: DeveloperDiagnosticsSnapshot | null = null,
    traces: DeveloperTraceEntry[] = [],
    busy = false,
    error = '',
    notice = '';
  let level = '',
    scope = '',
    phase = '',
    page = 0,
    mounted = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    refreshing = false,
    disposed = false;
  $: filtered = traces.filter(
    (t) =>
      (!level || t.level === level) &&
      (!scope || t.scope === scope) &&
      (!phase || t.phase.includes(phase)),
  );
  $: if (page * 20 >= filtered.length) page = 0;
  $: if (mounted && ($state.version >= 0 || $state.trace >= 0)) schedule();
  function schedule() {
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 500);
  }
  export async function refresh() {
    if (refreshing || disposed) return;
    refreshing = true;
    try {
      const [next, entries] = await Promise.all([
        nostr.getDeveloperDiagnosticsSnapshot(),
        nostr.listDeveloperTraceEntries(),
      ]);
      if (!disposed) {
        snapshot = next;
        traces = entries;
      }
    } catch {
      if (!disposed) error = 'Could not load diagnostics.';
    } finally {
      refreshing = false;
    }
  }
  async function act(action: () => unknown | Promise<unknown>, success = '') {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await action();
      if (success) notice = success;
      await refresh();
    } catch {
      error = 'The diagnostic action failed. Please try again.';
    } finally {
      busy = false;
    }
  }
  async function bundle(download: boolean) {
    const diagnostics = await nostr.getDeveloperDiagnosticsSnapshot();
    const traceEntries = await nostr.listDeveloperTraceEntries();
    const json = diagnosticJson({
      exportedAt: new Date().toISOString(),
      diagnostics,
      traceEntries,
    });
    if (!download) {
      await navigator.clipboard.writeText(json);
      notice = $translate('developer.developerDiagnosticsCopiedClipboard');
      return;
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `anagram-diagnostics-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onMount(() => {
    mounted = true;
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  });
</script>

<div class="developer-settings">
  <div class="settings-card">
    <label class="settings-switch"
      ><input
        type="checkbox"
        role="switch"
        checked={$state.enabled}
        onchange={(e) => nostr.setDeveloperDiagnosticsEnabled(e.currentTarget.checked)}
      /><span
        >{$translate('common.debugLogging')}<small
          >{$translate('developer.debugLogging.description')}</small
        ></span
      ></label
    >
  </div>
  <div class="settings-card">
    <div>
      <h3>{$translate('developer.appBundle')}</h3>
      <small>{$translate('developer.appBundle.description')}</small>
      <dl class="developer-facts">
        <dt>{$translate('common.appVersion')}</dt>
        <dd>{update.currentBuildInfo.appVersion}</dd>
        <dt>{$translate('developer.bundleId')}</dt>
        <dd>{update.currentBuildInfo.bundleId}</dd>
      </dl>
    </div>
  </div>
  <div class="settings-card">
    <div>
      <h3>{$translate('common.actions')}</h3>
      <small>{$translate('developer.actions.description')}</small>
    </div>
    <div class="settings-actions">
      <button
        class="outline"
        disabled={busy}
        onclick={() =>
          act(
            () => nostr.restartPrivateMessagesDiagnosticsSubscription(),
            $translate('developer.privateMessagesSubscriptionRestarted'),
          )}>{$translate('developer.restartDmSubscription')}</button
      ><button
        class="outline"
        disabled={busy}
        onclick={() =>
          act(
            () => nostr.reconnectAllDeveloperRelays(),
            $translate('developer.reconnectAll.started'),
          )}>{$translate('relays.reconnectAllRelays')}</button
      ><button class="outline" disabled={busy} onclick={() => act(() => bundle(false))}
        >{$translate('common.copyJson')}</button
      ><button
        class="outline"
        data-testid="settings-diagnostics-download"
        disabled={busy}
        onclick={() => act(() => bundle(true))}>{$translate('common.downloadJson')}</button
      ><button
        class="outline"
        disabled={busy}
        onclick={() => act(() => nostr.clearDeveloperTraceEntries())}
        >{$translate('developer.clearTrace')}</button
      >
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p role="status">
        {notice}
      </p>{/if}
  </div>
  <div class="settings-card">
    <details>
      <summary>{$translate('relays.relayStatus')}</summary
      >{#each snapshot?.relayRows ?? [] as relay}<div class="settings-relay settings-relay-head">
          <div class="relay-url">
            {diagnosticText(relay.url ?? '')}<br /><small
              >{relay.statusName} · {$translate('common.attempts')}: {relay.attempts ?? 0} · {relay.inReadSet
                ? 'Read '
                : ''}{relay.inPublishSet ? 'Publish ' : ''}{relay.inPrivateMessagesSubscription
                ? 'DM'
                : ''}</small
            >
          </div>
          <button
            class="link"
            disabled={busy || !relay.url}
            onclick={() => act(() => nostr.reconnectDeveloperRelay(relay.url!))}
            >{$translate('common.reconnect')}</button
          >
        </div>{:else}<p>{$translate('developer.relayDiagnosticsAvailableYet')}</p>{/each}
    </details>
  </div>
  {#each [['groupMessagesSubscription', 'developer.groupMessagesSubscription'], ['session', 'common.nostrSession'], ['privateMessagesSubscription', 'developer.privateMessagesSubscription']] as [key, label]}<div
      class="settings-card"
    >
      <details>
        <summary>{$translate(label)}</summary>
        <DiagnosticFields value={snapshot?.[key as keyof DeveloperDiagnosticsSnapshot]} />
      </details>
    </div>{/each}
  <div class="settings-card">
    <details open>
      <summary>{$translate('developer.pendingQueues')}</summary><button
        class="outline"
        disabled={busy}
        onclick={() =>
          act(async () => {
            const result = await nostr.refreshDeveloperPendingQueues();
            notice = `Checked ${result.initialTargetCount} targets; ${result.remainingEntryCount} items still pending.`;
          })}>{$translate('common.refresh')}</button
      >
      <h4>{$translate('message.pendingReactions.title')}</h4>
      <pre>{diagnosticJson(snapshot?.pendingReactions ?? [])}</pre>
      <h4>{$translate('developer.pendingDeletions.title')}</h4>
      <pre>{diagnosticJson(snapshot?.pendingDeletions ?? [])}</pre>
    </details>
  </div>
  <div class="settings-card">
    <details open>
      <summary>{$translate('developer.recentTrace')}</summary>
      <div class="settings-grid trace-filters">
        <label
          >{$translate('common.level')}<select bind:value={level}
            ><option value="">{$translate('common.none')}</option
            >{#each ['info', 'warn', 'error'] as item}<option>{item}</option>{/each}</select
          ></label
        ><label
          >{$translate('common.scope')}<select bind:value={scope}
            ><option value="">{$translate('common.none')}</option
            >{#each [...new Set(traces.map((t) => t.scope))] as item}<option>{item}</option
              >{/each}</select
          ></label
        ><label>{$translate('common.phase')}<input bind:value={phase} /></label>
      </div>
      {#each filtered.slice(page * 20, (page + 1) * 20) as trace (trace.id)}<details
          class="settings-relay"
        >
          <summary
            >{trace.timestamp} · {trace.level} · {diagnosticText(trace.scope)} · {diagnosticText(
              trace.phase,
            )}</summary
          >
          <pre>{diagnosticJson(trace.details)}</pre>
        </details>{:else}<p>
          {$translate(
            traces.length
              ? 'developer.traceEntriesMatchCurrent'
              : 'developer.traceEntriesCapturedYet',
          )}
        </p>{/each}
      <div class="settings-actions end">
        <button class="outline" disabled={page === 0} onclick={() => page--}
          >{$translate('common.back')}</button
        ><span>{page + 1} / {Math.max(1, Math.ceil(filtered.length / 20))}</span><button
          class="outline"
          disabled={(page + 1) * 20 >= filtered.length}
          onclick={() => page++}>{$translate('common.next')}</button
        >
      </div>
    </details>
  </div>
  <div class="settings-card">
    <details>
      <summary>{$translate('startup.startupHistory')}</summary>{#each $state.startup as step}<div
          class="settings-relay"
        >
          <div class="settings-relay-head">
            <span class="relay-url"
              >{$translate(step.label)} · {step.status} · {step.durationMs ?? 0} ms{step.eventCount !==
              null
                ? ` · ${step.eventCount} events`
                : ''}</span
            ><button
              class="link"
              disabled={busy || $state.restoring || step.status === 'in_progress'}
              onclick={() => act(() => nostr.rerunStartupStep(step.id))}
              >{$translate('common.retry')}</button
            >
          </div>
          {#if step.errorMessage}<p class="error">
              {diagnosticText(step.errorMessage)}
            </p>{/if}{#each step.internalTasks as task}<p class="settings-caption">
              {$translate(task.label)} · {task.status} · {task.durationMs ?? 0} ms
            </p>{/each}
        </div>{/each}
    </details>
  </div>
</div>
