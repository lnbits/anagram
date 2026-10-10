<script lang="ts">
  import { observe } from '#src/lib/state/store.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { translate } from '#src/i18n.ts';
  import {
    isStartupLockedStepIdValue,
    type StartupTimedSnapshot,
  } from '#src/stores/nostr/startupState.ts';
  import Icon from './Icon.svelte';

  const nostr = useNostrStore();
  const state = observe(() => ({
    steps: nostr.startupSteps.map((step) => ({
      ...step,
      internalTasks: step.internalTasks.map((task) => ({ ...task })),
    })),
    display: { ...nostr.startupDisplay },
    restoring: nostr.isRestoringStartupState,
  }));
  const preference = 'nostr-chat:startup-history-details-visible';
  let expanded = false;
  try {
    expanded = localStorage.getItem(preference) === 'true';
  } catch {
    /* Optional UI preference. */
  }
  $: steps = [...$state.steps].sort((a, b) => a.order - b.order);
  $: active = steps.filter(
    (step) =>
      step.status === 'in_progress' ||
      step.internalTasks.some((task) => task.status === 'in_progress'),
  );
  // The display snapshot can linger briefly after a step completes. Prefer work still running.
  $: current = active.find((step) => step.id === $state.display.stepId) ?? active[0];
  $: visible = $state.restoring || steps.some((step) => step.status !== 'pending');
  $: summary = current
    ? `${steps.indexOf(current) + 1}/${steps.length} ${$translate(current.label)}`
    : $translate(
        $state.restoring ? 'startup.preparingStartupRestore' : 'startup.startupHistory',
      );
  function toggle() {
    expanded = !expanded;
    try {
      localStorage.setItem(preference, String(expanded));
    } catch {
      /* Keep the toggle usable. */
    }
  }
  function duration(step: StartupTimedSnapshot) {
    if (step.durationMs === null)
      return $translate(step.status === 'in_progress' ? 'common.runningLabel' : 'common.pending');
    return step.durationMs < 1000
      ? `${Math.max(1, Math.round(step.durationMs))} ms`
      : `${(step.durationMs / 1000).toFixed(step.durationMs >= 10000 ? 0 : 1)} s`;
  }
  function meta(step: StartupTimedSnapshot) {
    // Relay/signer exceptions can contain private input; display only a fixed status.
    const status = $translate(
      step.status === 'success'
        ? 'common.completed'
        : step.status === 'error'
          ? 'common.failed'
          : step.status === 'in_progress'
            ? 'common.progress'
            : 'common.pending',
      { duration: duration(step) },
    );
    return typeof step.eventCount === 'number' && Number.isFinite(step.eventCount)
      ? `${status} · ${$translate(step.eventCount === 1 ? 'common.eventCount.one' : 'common.eventCount.many', { count: Math.max(0, Math.floor(step.eventCount)) })}`
      : status;
  }
</script>

{#snippet indicator(step: StartupTimedSnapshot)}
  {#if step.status === 'in_progress'}
    <span class="mini-progress" aria-label={$translate('common.progress')}></span>
  {:else}<span
      class="status-icon"
      class:success={step.status === 'success'}
      class:failed={step.status === 'error'}
    >
      <Icon
        name={step.status === 'success' ? 'check' : step.status === 'error' ? 'close' : 'more'}
      />
    </span>{/if}
{/snippet}
{#if visible}
  <section
    class="startup-history"
    class:expanded
    data-testid="history-sync-status"
    aria-label={$translate('startup.startupHistory')}
  >
    <div class="summary-row">
      <span class="summary" role="status">{summary}</span>
      <button
        class="toggle"
        onclick={toggle}
        aria-expanded={expanded}
        aria-controls="startup-history-details"
        aria-label={$translate(
          expanded ? 'startup.hideStartupHistory' : 'startup.showStartupHistory',
        )}
      >
        <Icon name="more" />
      </button>
    </div>
    {#if expanded}
      <div id="startup-history-details" class="details">
        <strong class="title">{$translate('startup.startupHistory')}</strong>
        <ol>
          {#each steps as step, index (step.id)}
            <li>
              <div class="step-row">
                <span class="counter">{index + 1}/{steps.length}</span>
                {@render indicator(step)}
                <div class="copy">
                  <div class="label">
                    {#if isStartupLockedStepIdValue(step.id)}<Icon name="lock" />{/if}<span
                      >{$translate(step.label)}</span
                    >
                  </div>
                  <div class="meta">{meta(step)}</div>
                </div>
                <span class="duration">{duration(step)}</span>
              </div>
              {#if step.internalTasks.length}<div class="tasks">
                  {#each step.internalTasks as task (task.id)}<div class="task-row">
                      {@render indicator(task)}
                      <div class="copy">
                        <div class="task-label">{$translate(task.label)}</div>
                        <div class="meta">{meta(task)}</div>
                      </div>
                      <span class="duration">{duration(task)}</span>
                    </div>{/each}
                </div>{/if}
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  </section>
{/if}

<style>
  .startup-history {
    position: relative;
    flex: 0 0 auto;
    min-width: 0;
    color: var(--nc-text);
    background: var(--nc-panel-header-bg);
    border-bottom: 1px solid var(--nc-border);
  }
  .expanded {
    background: color-mix(in srgb, var(--q-primary) 7%, var(--nc-panel-header-bg));
  }
  .summary-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 0 10px;
    color: var(--nc-text-secondary);
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 32px;
    height: 32px;
    padding: 0;
    color: inherit;
  }
  .summary {
    flex: 1;
    min-width: 0;
    font-size: 10px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .details {
    padding: 0 8px 8px;
  }
  .title {
    display: block;
    margin-bottom: 6px;
    font-size: 10px;
    text-transform: uppercase;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0 4px 0 0;
    display: grid;
    gap: 7px;
    max-height: min(260px, 35dvh);
    overflow-y: auto;
  }
  li + li {
    border-top: 1px solid color-mix(in srgb, var(--nc-border) 70%, transparent);
    padding-top: 7px;
  }
  .step-row {
    display: grid;
    grid-template-columns: 34px 22px minmax(0, 1fr) auto;
    gap: 7px;
    align-items: start;
  }
  .counter {
    font-size: 10px;
    font-weight: 700;
    color: var(--nc-text-secondary);
  }
  .copy {
    min-width: 0;
  }
  .label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.25;
  }
  .meta,
  .duration {
    color: var(--nc-text-secondary);
    font-size: 10px;
    line-height: 1.35;
  }
  .duration {
    white-space: nowrap;
  }
  .tasks {
    display: grid;
    gap: 5px;
    padding: 6px 0 0 56px;
  }
  .task-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: 7px;
    align-items: start;
  }
  .task-label {
    font-size: 10px;
    font-weight: 600;
  }
  .status-icon :global(svg) {
    width: 15px;
    height: 15px;
  }
  .toggle :global(svg) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .label :global(svg) {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }
  .status-icon {
    color: var(--nc-text-secondary);
  }
  .success {
    color: var(--nc-success);
  }
  .failed {
    color: var(--nc-danger);
  }
  .mini-progress {
    overflow: hidden;
    background: color-mix(in srgb, var(--q-primary) 15%, transparent);
  }
  .mini-progress {
    width: 18px;
    height: 4px;
    border-radius: 999px;
    margin-top: 6px;
  }
  .mini-progress::after {
    content: '';
    display: block;
    height: 100%;
    width: 40%;
    background: var(--q-primary);
    animation: indeterminate 1.8s ease-in-out infinite;
  }
  @keyframes indeterminate {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(350%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mini-progress::after {
      animation: none;
      width: 100%;
    }
  }
  @media (max-width: 420px) {
    .step-row {
      grid-template-columns: 34px 22px minmax(0, 1fr);
    }
    .duration {
      grid-column: 3;
    }
    .task-row {
      grid-template-columns: 22px minmax(0, 1fr);
    }
    .task-row .duration {
      grid-column: 2;
    }
  }
</style>
