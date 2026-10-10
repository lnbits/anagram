import {
  beginStartupTimedSnapshotValue,
  completeStartupTimedSnapshotValue,
  failStartupTimedSnapshotValue,
  getStartupInternalTaskDefinitionValue,
  resetStartupStepSnapshotsValue,
  resolveStartupStepIdValue,
  type StartupDisplaySnapshot,
  type StartupInternalTaskSnapshot,
  type StartupStepId,
  type StartupStepSnapshot,
  type StartupTrackId,
} from '#src/stores/nostr/startupState.ts';
import type { Ref } from '#src/lib/state/reactivity.ts';

interface StartupRuntimeState {
  startupDisplayShownAt: number;
  startupDisplayTimer: ReturnType<typeof globalThis.setTimeout> | null;
  startupDisplayToken: number;
}

interface StartupRuntimeDeps {
  startupDisplay: Ref<StartupDisplaySnapshot>;
  startupState: StartupRuntimeState;
  startupSteps: Ref<StartupStepSnapshot[]>;
  startupStepMinProgressMs: number;
}

interface StartupInternalTaskUpdate {
  eventCount?: number | null;
  label?: string;
}

interface StartupStepUpdate {
  eventCount?: number | null;
  label?: string;
}

export function createStartupRuntime({
  startupDisplay,
  startupState,
  startupSteps,
  startupStepMinProgressMs,
}: StartupRuntimeDeps) {
  function clearStartupDisplayTimer(): void {
    if (startupState.startupDisplayTimer !== null) {
      globalThis.clearTimeout(startupState.startupDisplayTimer);
      startupState.startupDisplayTimer = null;
    }
  }

  function getStartupStepSnapshot(stepId: StartupTrackId): StartupStepSnapshot {
    const parentStepId = resolveStartupStepIdValue(stepId);
    const step = startupSteps.value.find((entry) => entry.id === stepId);
    if (step) {
      return step;
    }

    const parentStep = startupSteps.value.find((entry) => entry.id === parentStepId);
    if (parentStep) {
      return parentStep;
    }

    throw new Error(`Unknown startup step: ${stepId}`);
  }

  function getStartupInternalTaskSnapshot(
    taskId: string,
    parentStepId?: StartupStepId
  ): StartupInternalTaskSnapshot | null {
    const taskDefinition = getStartupInternalTaskDefinitionValue(taskId);
    if (taskDefinition) {
      const parentStep = getStartupStepSnapshot(taskDefinition.parentId);
      return parentStep.internalTasks.find((entry) => entry.id === taskId) ?? null;
    }

    if (parentStepId) {
      const parentStep = getStartupStepSnapshot(parentStepId);
      return parentStep.internalTasks.find((entry) => entry.id === taskId) ?? null;
    }

    for (const step of startupSteps.value) {
      const task = step.internalTasks.find((entry) => entry.id === taskId);
      if (task) {
        return task;
      }
    }

    return null;
  }

  function ensureStartupInternalTaskSnapshot(options: {
    taskId: string;
    parentStepId?: StartupStepId;
    label?: string;
    eventCount?: number | null;
  }): StartupInternalTaskSnapshot {
    const { taskId } = options;
    const taskDefinition = getStartupInternalTaskDefinitionValue(taskId);
    const parentStepId = options.parentStepId ?? taskDefinition?.parentId;
    if (!parentStepId) {
      throw new Error(`Unknown startup task: ${taskId}`);
    }

    const parentStep = getStartupStepSnapshot(parentStepId);
    const existingTask = parentStep.internalTasks.find((entry) => entry.id === taskId);
    if (existingTask) {
      if (options.label) {
        existingTask.label = options.label;
      }
      if (options.eventCount !== undefined) {
        existingTask.eventCount = options.eventCount;
      }
      return existingTask;
    }

    const nextTask: StartupInternalTaskSnapshot = {
      id: taskId,
      label: options.label ?? taskDefinition?.label ?? taskId,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      errorMessage: null,
      eventCount: options.eventCount ?? null,
    };
    parentStep.internalTasks.push(nextTask);
    return nextTask;
  }

  function getStartupTrackLabel(stepId: StartupTrackId): string {
    const internalTask = getStartupInternalTaskDefinitionValue(stepId);
    if (internalTask) {
      return internalTask.label;
    }

    const step = getStartupStepSnapshot(stepId);
    if (!step) {
      throw new Error(`Unknown startup step: ${stepId}`);
    }

    return step.label;
  }

  function showStartupStepProgress(stepId: StartupTrackId): void {
    const parentStepId = resolveStartupStepIdValue(stepId);
    startupState.startupDisplayToken += 1;
    startupState.startupDisplayShownAt = Date.now();
    clearStartupDisplayTimer();
    startupDisplay.value = {
      stepId: parentStepId,
      label: getStartupTrackLabel(stepId),
      status: 'in_progress',
      showProgress: true,
    };
  }

  function finalizeStartupStepDisplay(stepId: StartupTrackId, status: 'success' | 'error'): void {
    const parentStepId = resolveStartupStepIdValue(stepId);
    if (startupDisplay.value.stepId !== parentStepId) {
      return;
    }

    const displayToken = ++startupState.startupDisplayToken;
    const label = getStartupTrackLabel(stepId);
    const applyFinalState = () => {
      if (displayToken !== startupState.startupDisplayToken) {
        return;
      }

      startupDisplay.value = {
        stepId: parentStepId,
        label,
        status,
        showProgress: false,
      };
      startupState.startupDisplayTimer = null;
    };

    const elapsedMs =
      startupState.startupDisplayShownAt > 0 ? Date.now() - startupState.startupDisplayShownAt : 0;
    const remainingProgressMs = Math.max(startupStepMinProgressMs - elapsedMs, 0);
    clearStartupDisplayTimer();

    if (remainingProgressMs > 0) {
      startupState.startupDisplayTimer = globalThis.setTimeout(
        applyFinalState,
        remainingProgressMs
      );
      return;
    }

    applyFinalState();
  }

  function beginStartupStep(stepId: StartupTrackId): void {
    const now = Date.now();
    const internalTaskDefinition = getStartupInternalTaskDefinitionValue(stepId);
    const parentStep = getStartupStepSnapshot(stepId);
    const nextStep = beginStartupTimedSnapshotValue(parentStep, now);
    if (nextStep === parentStep) {
      if (internalTaskDefinition) {
        const task = ensureStartupInternalTaskSnapshot({ taskId: internalTaskDefinition.id });
        Object.assign(task, beginStartupTimedSnapshotValue(task, now));
        showStartupStepProgress(stepId);
      }
      return;
    }

    Object.assign(parentStep, nextStep);
    if (internalTaskDefinition) {
      const task = ensureStartupInternalTaskSnapshot({ taskId: internalTaskDefinition.id });
      Object.assign(task, beginStartupTimedSnapshotValue(task, now));
    }
    showStartupStepProgress(stepId);
  }

  function completeStartupStep(stepId: StartupTrackId): void {
    const now = Date.now();
    const internalTaskDefinition = getStartupInternalTaskDefinitionValue(stepId);
    if (internalTaskDefinition) {
      const task = ensureStartupInternalTaskSnapshot({ taskId: internalTaskDefinition.id });
      Object.assign(task, completeStartupTimedSnapshotValue(task, now));
      if (
        'completeParentOnFinish' in internalTaskDefinition &&
        internalTaskDefinition.completeParentOnFinish === true
      ) {
        const parentStep = getStartupStepSnapshot(internalTaskDefinition.parentId);
        Object.assign(parentStep, completeStartupTimedSnapshotValue(parentStep, now));
      }
      finalizeStartupStepDisplay(stepId, 'success');
      return;
    }

    const step = getStartupStepSnapshot(stepId);
    Object.assign(step, completeStartupTimedSnapshotValue(step, now));
    finalizeStartupStepDisplay(stepId, 'success');
  }

  function failStartupStep(stepId: StartupTrackId, error: unknown): void {
    const now = Date.now();
    const internalTaskDefinition = getStartupInternalTaskDefinitionValue(stepId);
    if (internalTaskDefinition) {
      const task = ensureStartupInternalTaskSnapshot({ taskId: internalTaskDefinition.id });
      Object.assign(task, failStartupTimedSnapshotValue(task, error, now));
      if (
        'completeParentOnFinish' in internalTaskDefinition &&
        internalTaskDefinition.completeParentOnFinish === true
      ) {
        const parentStep = getStartupStepSnapshot(internalTaskDefinition.parentId);
        Object.assign(parentStep, failStartupTimedSnapshotValue(parentStep, error, now));
      }
      finalizeStartupStepDisplay(stepId, 'error');
      return;
    }

    const step = getStartupStepSnapshot(stepId);
    Object.assign(step, failStartupTimedSnapshotValue(step, error, now));
    finalizeStartupStepDisplay(stepId, 'error');
  }

  function resetStartupStepTracking(): void {
    clearStartupDisplayTimer();
    startupState.startupDisplayToken += 1;
    startupState.startupDisplayShownAt = 0;
    startupSteps.value = resetStartupStepSnapshotsValue();
    startupDisplay.value = {
      stepId: null,
      label: null,
      status: null,
      showProgress: false,
    };
  }

  function resetStartupStep(stepId: StartupStepId): void {
    const step = getStartupStepSnapshot(stepId);
    const nextStep = resetStartupStepSnapshotsValue().find((entry) => entry.id === stepId);
    if (!nextStep) {
      throw new Error(`Unknown startup step: ${stepId}`);
    }

    Object.assign(step, nextStep);
    if (startupDisplay.value.stepId !== stepId) {
      return;
    }

    clearStartupDisplayTimer();
    startupState.startupDisplayToken += 1;
    startupState.startupDisplayShownAt = 0;
    startupDisplay.value = {
      stepId: null,
      label: null,
      status: null,
      showProgress: false,
    };
  }

  function beginStartupInternalTask(
    parentStepId: StartupStepId,
    taskId: string,
    label: string,
    updates: StartupInternalTaskUpdate = {}
  ): void {
    const now = Date.now();
    const parentStep = getStartupStepSnapshot(parentStepId);
    if (parentStep.status === 'in_progress') {
      Object.assign(parentStep, beginStartupTimedSnapshotValue(parentStep, now));
    } else if (parentStep.startedAt !== null) {
      Object.assign(parentStep, {
        ...parentStep,
        status: 'in_progress',
        completedAt: null,
        durationMs: null,
        errorMessage: null,
      });
    } else {
      Object.assign(parentStep, beginStartupTimedSnapshotValue(parentStep, now));
    }
    const task = ensureStartupInternalTaskSnapshot({
      taskId,
      parentStepId,
      label,
      eventCount: updates.eventCount ?? null,
    });
    Object.assign(task, beginStartupTimedSnapshotValue(task, now));
    if (updates.label) {
      task.label = updates.label;
    }
    showStartupStepProgress(parentStepId);
  }

  function updateStartupInternalTask(
    parentStepId: StartupStepId,
    taskId: string,
    updates: StartupInternalTaskUpdate
  ): void {
    const task = getStartupInternalTaskSnapshot(taskId, parentStepId);
    if (!task) {
      return;
    }

    if (updates.label) {
      task.label = updates.label;
    }
    if (updates.eventCount !== undefined) {
      task.eventCount = updates.eventCount;
    }
  }

  function updateStartupStep(stepId: StartupStepId, updates: StartupStepUpdate): void {
    const step = getStartupStepSnapshot(stepId);

    if (updates.label) {
      step.label = updates.label;
      if (startupDisplay.value.stepId === stepId) {
        startupDisplay.value = {
          ...startupDisplay.value,
          label: updates.label,
        };
      }
    }
    if (updates.eventCount !== undefined) {
      step.eventCount = updates.eventCount;
    }
  }

  function completeStartupInternalTask(
    parentStepId: StartupStepId,
    taskId: string,
    updates: StartupInternalTaskUpdate = {}
  ): void {
    const now = Date.now();
    const task = getStartupInternalTaskSnapshot(taskId, parentStepId);
    if (!task) {
      return;
    }

    updateStartupInternalTask(parentStepId, taskId, updates);
    Object.assign(task, completeStartupTimedSnapshotValue(task, now));
    finalizeStartupStepDisplay(parentStepId, 'success');
  }

  function failStartupInternalTask(
    parentStepId: StartupStepId,
    taskId: string,
    error: unknown,
    updates: StartupInternalTaskUpdate = {}
  ): void {
    const now = Date.now();
    const task = getStartupInternalTaskSnapshot(taskId, parentStepId);
    if (!task) {
      return;
    }

    updateStartupInternalTask(parentStepId, taskId, updates);
    Object.assign(task, failStartupTimedSnapshotValue(task, error, now));
    finalizeStartupStepDisplay(parentStepId, 'error');
  }

  function createStartupBatchTracker(stepId: StartupTrackId): {
    beginItem: () => void;
    finishItem: (error?: unknown) => void;
    seal: () => void;
  } {
    let started = false;
    let sealed = false;
    let inFlightCount = 0;

    const maybeComplete = () => {
      if (!sealed || inFlightCount > 0) {
        return;
      }

      const internalTaskDefinition = getStartupInternalTaskDefinitionValue(stepId);
      if (internalTaskDefinition) {
        const task = getStartupInternalTaskSnapshot(internalTaskDefinition.id);
        if (task?.status === 'in_progress') {
          completeStartupStep(stepId);
        }
        return;
      }

      const step = getStartupStepSnapshot(stepId);
      if (step.status === 'in_progress') {
        completeStartupStep(stepId);
      }
    };

    return {
      beginItem() {
        if (!started) {
          beginStartupStep(stepId);
          started = true;
        }
        inFlightCount += 1;
      },
      finishItem(error?: unknown) {
        if (!started) {
          beginStartupStep(stepId);
          started = true;
        }

        inFlightCount = Math.max(0, inFlightCount - 1);
        if (error) {
          failStartupStep(stepId, error);
          return;
        }

        maybeComplete();
      },
      seal() {
        sealed = true;
        if (!started) {
          beginStartupStep(stepId);
          completeStartupStep(stepId);
          return;
        }

        maybeComplete();
      },
    };
  }

  return {
    beginStartupInternalTask,
    beginStartupStep,
    clearStartupDisplayTimer,
    completeStartupInternalTask,
    completeStartupStep,
    createStartupBatchTracker,
    failStartupInternalTask,
    failStartupStep,
    finalizeStartupStepDisplay,
    getStartupStepSnapshot,
    resetStartupStep,
    resetStartupStepTracking,
    showStartupStepProgress,
    updateStartupInternalTask,
    updateStartupStep,
  };
}
