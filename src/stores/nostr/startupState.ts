export const STARTUP_STEP_DEFINITIONS = [
  { id: 'my-relays-restore', order: 1, label: 'startup.restoreMyRelayList' },
  { id: 'my-relays-subscribe', order: 2, label: 'startup.subscribeMyRelayListUpdates' },
  { id: 'outbound-message-replay', order: 3, label: 'startup.startOutboundMessageReplay' },
  { id: 'private-preferences', order: 4, label: 'startup.restorePrivatePreferences' },
  { id: 'private-contact-list-restore', order: 5, label: 'startup.restorePrivateContactList' },
  {
    id: 'group-identity-secrets',
    order: 6,
    label: 'startup.restoreGroupIdentitySecrets',
  },
  { id: 'group-relay-lists-refresh', order: 7, label: 'startup.refreshGroupRelayLists' },
  {
    id: 'contact-cursor-state',
    order: 8,
    label: 'startup.restoreContactCursorState',
  },
  { id: 'logged-in-contact-profile', order: 9, label: 'startup.syncLoggedInContactProfile' },
  { id: 'recent-chat-contacts-sync', order: 10, label: 'startup.syncRecentChatContacts' },
  {
    id: 'private-contact-list-subscribe',
    order: 11,
    label: 'startup.subscribePrivateContactListUpdates',
  },
  { id: 'private-messages-subscribe', order: 12, label: 'startup.listenForNewMessages' },
  { id: 'group-rosters-subscribe', order: 13, label: 'startup.subscribeGroupRosters' },
  { id: 'contact-profile-subscribe', order: 14, label: 'startup.subscribeContactProfileUpdates' },
  {
    id: 'contact-relay-list-subscribe',
    order: 15,
    label: 'startup.subscribeContactRelayListUpdates',
  },
  { id: 'message-history-restore', order: 16, label: 'startup.restoreMessageHistory' },
] as const;

export type StartupStepId = (typeof STARTUP_STEP_DEFINITIONS)[number]['id'];

export const STARTUP_LOCKED_STEP_IDS = [
  'private-preferences',
  'private-contact-list-restore',
  'group-identity-secrets',
  'contact-cursor-state',
] as const satisfies readonly StartupStepId[];

const STARTUP_LOCKED_STEP_ID_SET = new Set<string>(STARTUP_LOCKED_STEP_IDS);

export function isStartupLockedStepIdValue(stepId: string): boolean {
  return STARTUP_LOCKED_STEP_ID_SET.has(stepId);
}

export const STARTUP_INTERNAL_TASK_DEFINITIONS = [
  {
    id: 'my-relay-list',
    parentId: 'my-relays-restore',
    label: 'startup.fetchApplyNip65RelayList',
  },
  {
    id: 'private-contact-list',
    parentId: 'private-contact-list-restore',
    label: 'startup.fetchDecryptApplyContactList',
  },
  {
    id: 'private-contact-profiles',
    parentId: 'private-contact-list-restore',
    label: 'startup.privateContactProfileMetadata',
  },
  {
    id: 'private-contact-relays',
    parentId: 'private-contact-list-restore',
    label: 'startup.privateContactRelayLists',
  },
  {
    id: 'mute-list',
    parentId: 'contact-cursor-state',
    label: 'startup.fetchApplyMuteList',
  },
  {
    id: 'contact-cursor-data',
    parentId: 'contact-cursor-state',
    label: 'startup.fetchApplyContactCursorData',
  },
  {
    id: 'logged-in-profile',
    parentId: 'logged-in-contact-profile',
    label: 'startup.loggedInUserProfileMetadata',
  },
  {
    id: 'logged-in-relays',
    parentId: 'logged-in-contact-profile',
    label: 'startup.loggedInUserRelayList',
  },
  {
    id: 'recent-chat-profiles',
    parentId: 'recent-chat-contacts-sync',
    label: 'startup.recentChatContactProfiles',
  },
  {
    id: 'recent-chat-relays',
    parentId: 'recent-chat-contacts-sync',
    label: 'startup.recentChatContactRelayLists',
  },
  {
    id: 'private-message-events',
    parentId: 'private-messages-subscribe',
    label: 'startup.livePrivateMessageRelaySync',
    completeParentOnFinish: true,
  },
] as const satisfies readonly {
  id: string;
  parentId: StartupStepId;
  label: string;
  completeParentOnFinish?: boolean;
}[];

export type StartupInternalTaskId = (typeof STARTUP_INTERNAL_TASK_DEFINITIONS)[number]['id'];
export type StartupTrackId = StartupStepId | StartupInternalTaskId;
export type StartupStepStatus = 'pending' | 'in_progress' | 'success' | 'error';

export interface StartupTimedSnapshot {
  id: string;
  label: string;
  status: StartupStepStatus;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  eventCount: number | null;
}

export interface StartupInternalTaskSnapshot extends StartupTimedSnapshot {
  id: string;
}

export interface StartupStepSnapshot extends StartupTimedSnapshot {
  id: StartupStepId;
  order: number;
  internalTasks: StartupInternalTaskSnapshot[];
}

export interface StartupDisplaySnapshot {
  stepId: StartupStepId | null;
  label: string | null;
  status: StartupStepStatus | null;
  showProgress: boolean;
}

export function createInitialStartupStepSnapshots(): StartupStepSnapshot[] {
  return STARTUP_STEP_DEFINITIONS.map((step) => ({
    ...step,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorMessage: null,
    eventCount: null,
    internalTasks: [],
  }));
}

export function beginStartupTimedSnapshotValue<TSnapshot extends StartupTimedSnapshot>(
  step: TSnapshot,
  now: number
): TSnapshot {
  if (step.status === 'in_progress') {
    return step;
  }

  return {
    ...step,
    status: 'in_progress',
    startedAt: now,
    completedAt: null,
    durationMs: null,
    errorMessage: null,
    eventCount: step.eventCount ?? null,
  } as TSnapshot;
}

export function completeStartupTimedSnapshotValue<TSnapshot extends StartupTimedSnapshot>(
  step: TSnapshot,
  now: number
): TSnapshot {
  const startedAt = step.startedAt ?? now;
  return {
    ...step,
    status: 'success',
    startedAt,
    completedAt: now,
    durationMs: Math.max(0, now - startedAt),
    errorMessage: null,
    eventCount: step.eventCount ?? null,
  } as TSnapshot;
}

export function failStartupTimedSnapshotValue<TSnapshot extends StartupTimedSnapshot>(
  step: TSnapshot,
  error: unknown,
  now: number
): TSnapshot {
  const startedAt = step.startedAt ?? now;
  return {
    ...step,
    status: 'error',
    startedAt,
    completedAt: now,
    durationMs: Math.max(0, now - startedAt),
    errorMessage: error instanceof Error ? error.message : String(error),
    eventCount: step.eventCount ?? null,
  } as TSnapshot;
}

export const beginStartupStepSnapshotValue = beginStartupTimedSnapshotValue<StartupStepSnapshot>;
export const completeStartupStepSnapshotValue =
  completeStartupTimedSnapshotValue<StartupStepSnapshot>;
export const failStartupStepSnapshotValue = failStartupTimedSnapshotValue<StartupStepSnapshot>;

export function resolveStartupStepIdValue(trackId: StartupTrackId): StartupStepId {
  const directStep = STARTUP_STEP_DEFINITIONS.find((step) => step.id === trackId);
  if (directStep) {
    return directStep.id;
  }

  const internalTask = STARTUP_INTERNAL_TASK_DEFINITIONS.find((task) => task.id === trackId);
  if (!internalTask) {
    throw new Error(`Unknown startup step: ${trackId}`);
  }

  return internalTask.parentId;
}

export function getStartupInternalTaskDefinitionValue(
  trackId: string
): (typeof STARTUP_INTERNAL_TASK_DEFINITIONS)[number] | null {
  return STARTUP_INTERNAL_TASK_DEFINITIONS.find((task) => task.id === trackId) ?? null;
}

export function resetStartupStepSnapshotsValue(): StartupStepSnapshot[] {
  return createInitialStartupStepSnapshots();
}
