import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS } from 'src/stores/nostr/constants';
import {
  RelayQueryTimeoutError,
  RelayQueryUnavailableError,
} from 'src/stores/nostr/relayQueryUtils';
import {
  isStartupCheckpointCurrent,
  readStartupCheckpoint,
  writeStartupCheckpoint,
} from 'src/stores/nostr/startupCheckpoint';
import type { StartupStepId } from 'src/stores/nostr/startupState';
import type {
  ContactCursorContent,
  ContactRefreshLifecycle,
  PrivatePreferences,
  SubscribePrivateMessagesOptions,
} from 'src/stores/nostr/types';
import type { ContactRecord } from 'src/types/contact';
import { yieldToMainThread } from 'src/utils/backgroundTasks';
import type { Ref } from 'vue';

interface StartupBatchTracker {
  beginItem: () => void;
  finishItem: (error?: unknown) => void;
  seal: () => void;
}

interface RefreshAllStoredContactsSummary {
  totalCount: number;
  refreshedCount: number;
  failedCount: number;
  cursorContactCount: number;
  cursorAppliedCount: number;
  cursorUiReloaded: boolean;
}

const STARTUP_RESTORE_STEP_ORDER = [
  'my-relays-restore',
  'my-relays-subscribe',
  'outbound-message-replay',
  'private-preferences',
  'private-contact-list-restore',
  'group-identity-secrets',
  'group-relay-lists-refresh',
  'contact-cursor-state',
  'logged-in-contact-profile',
  'recent-chat-contacts-sync',
  'private-contact-list-subscribe',
  'private-messages-subscribe',
  'group-rosters-subscribe',
  'contact-profile-subscribe',
  'contact-relay-list-subscribe',
] as const satisfies readonly StartupStepId[];

const STARTUP_TASK_ERROR_MESSAGES: Record<StartupStepId, string> = {
  'my-relays-restore': 'Failed to restore My Relays on startup',
  'my-relays-subscribe': 'Failed to subscribe to My Relays updates on startup',
  'outbound-message-replay': 'Failed to start outbound message replay on startup',
  'private-preferences': 'Failed to restore private preferences on startup',
  'private-contact-list-restore': 'Failed to restore private contact list on startup',
  'group-identity-secrets': 'Failed to restore group identity secrets on startup',
  'group-relay-lists-refresh': 'Failed to refresh group relay lists on startup',
  'contact-cursor-state': 'Failed to restore contact cursor state on startup',
  'logged-in-contact-profile': 'Failed to sync logged-in contact on startup',
  'recent-chat-contacts-sync': 'Failed to sync recent chat contacts on startup',
  'private-contact-list-subscribe':
    'Failed to subscribe to private contact list updates on startup',
  'private-messages-subscribe': 'Failed to subscribe to private messages on startup',
  'group-rosters-subscribe': 'Failed to subscribe to group rosters on startup',
  'contact-profile-subscribe': 'Failed to subscribe to contact profile updates on startup',
  'contact-relay-list-subscribe': 'Failed to subscribe to contact relay list updates on startup',
};

function isExpectedRelayQueryDeferral(error: unknown): boolean {
  return error instanceof RelayQueryTimeoutError || error instanceof RelayQueryUnavailableError;
}

interface StartupTaskRunOptions {
  forceSubscriptions?: boolean;
  propagateError?: boolean;
  resetStep?: boolean;
}

interface StartupContactSyncRuntimeDeps {
  applyContactCursorStateToContact: (
    contact: ContactRecord,
    cursor: ContactCursorContent
  ) => Promise<boolean>;
  beginStartupStep: (stepId: StartupStepId) => void;
  bumpContactListVersion: () => void;
  completeStartupStep: (stepId: StartupStepId) => void;
  createStartupBatchTracker: (
    stepId: 'logged-in-profile' | 'logged-in-relays' | 'recent-chat-profiles' | 'recent-chat-relays'
  ) => StartupBatchTracker;
  deriveContactCursorDTag: (contactPublicKey: string) => Promise<string | null>;
  ensureRelayConnections: (relayUrls: string[]) => Promise<void>;
  ensureStoredEventSince: () => void;
  fetchContactCursorEvents: (
    contacts: ContactRecord[]
  ) => Promise<Map<string, ContactCursorContent>>;
  failStartupStep: (stepId: StartupStepId, error: unknown) => void;
  flushPendingEventSinceUpdate: () => void;
  getConfiguredRelayUrls: () => string[];
  getLoggedInPublicKeyHex: () => string | null;
  getRestoreStartupStatePromise: () => Promise<void> | null;
  getSyncLoggedInContactProfilePromise: () => Promise<void> | null;
  getSyncRecentChatContactsPromise: () => Promise<void> | null;
  isRestoringStartupState: Ref<boolean>;
  readPrivatePreferencesFromStorage: () => PrivatePreferences | null;
  reloadChats: () => Promise<void>;
  refreshContactByPublicKey: (
    pubkeyHex: string,
    fallbackName?: string,
    lifecycle?: ContactRefreshLifecycle
  ) => Promise<unknown>;
  refreshGroupRelayListsOnStartup: (seedRelayUrls?: string[]) => Promise<void>;
  resetStartupStep: (stepId: StartupStepId) => void;
  resetStartupStepTracking: () => void;
  restoreContactCursorState: (seedRelayUrls?: string[]) => Promise<void>;
  restoreGroupIdentitySecrets: (seedRelayUrls?: string[]) => Promise<void>;
  restoreMyRelayList: (seedRelayUrls?: string[]) => Promise<void>;
  restoreMuteList: (seedRelayUrls?: string[]) => Promise<void>;
  restorePrivateContactList: (seedRelayUrls?: string[]) => Promise<void>;
  restorePrivatePreferences: (seedRelayUrls?: string[]) => Promise<void>;
  runLightweightSessionResume: (seedRelayUrls?: string[]) => Promise<void>;
  startOutboundMessageReplay: () => Promise<void>;
  setRestoreStartupStatePromise: (promise: Promise<void> | null) => void;
  setSyncLoggedInContactProfilePromise: (promise: Promise<void> | null) => void;
  setSyncRecentChatContactsPromise: (promise: Promise<void> | null) => void;
  subscribeContactProfileUpdates: (seedRelayUrls?: string[], force?: boolean) => Promise<void>;
  subscribeContactRelayListUpdates: (seedRelayUrls?: string[], force?: boolean) => Promise<void>;
  subscribeGroupMembershipRosterUpdates: (
    seedRelayUrls?: string[],
    force?: boolean
  ) => Promise<void>;
  subscribeMyRelayListUpdates: (seedRelayUrls?: string[], force?: boolean) => Promise<void>;
  subscribePrivateContactListUpdates: (seedRelayUrls?: string[], force?: boolean) => Promise<void>;
  subscribePrivateMessagesForLoggedInUser: (
    force?: boolean,
    options?: SubscribePrivateMessagesOptions
  ) => Promise<void>;
}

function logStartupRestore(phase: string, details: Record<string, unknown> = {}): void {
  console.log('[nostr-chat][startup-restore]', phase, details);
}

function formatStartupRestoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function createStartupContactSyncRuntime({
  applyContactCursorStateToContact,
  beginStartupStep,
  bumpContactListVersion,
  completeStartupStep,
  createStartupBatchTracker,
  deriveContactCursorDTag,
  ensureRelayConnections,
  ensureStoredEventSince,
  fetchContactCursorEvents,
  failStartupStep,
  flushPendingEventSinceUpdate,
  getConfiguredRelayUrls,
  getLoggedInPublicKeyHex,
  getRestoreStartupStatePromise,
  getSyncLoggedInContactProfilePromise,
  getSyncRecentChatContactsPromise,
  isRestoringStartupState,
  readPrivatePreferencesFromStorage,
  reloadChats,
  refreshContactByPublicKey,
  refreshGroupRelayListsOnStartup,
  resetStartupStep,
  resetStartupStepTracking,
  restoreContactCursorState,
  restoreGroupIdentitySecrets,
  restoreMyRelayList,
  restoreMuteList,
  restorePrivateContactList,
  restorePrivatePreferences,
  runLightweightSessionResume,
  startOutboundMessageReplay,
  setRestoreStartupStatePromise,
  setSyncLoggedInContactProfilePromise,
  setSyncRecentChatContactsPromise,
  subscribeContactProfileUpdates,
  subscribeContactRelayListUpdates,
  subscribeGroupMembershipRosterUpdates,
  subscribeMyRelayListUpdates,
  subscribePrivateContactListUpdates,
  subscribePrivateMessagesForLoggedInUser,
}: StartupContactSyncRuntimeDeps) {
  let initializeSessionStatePromise: Promise<void> | null = null;
  let initializedSessionPubkey: string | null = null;

  function getCheckpointRelayUrls(fallbackRelayUrls: string[]): string[] {
    const configuredRelayUrls = inputSanitizerService.normalizeStringArray(
      getConfiguredRelayUrls()
    );
    return configuredRelayUrls.length > 0 ? configuredRelayUrls : fallbackRelayUrls;
  }

  async function refreshAllStoredContacts(): Promise<RefreshAllStoredContactsSummary> {
    await contactsService.init();
    const storedContacts = await contactsService.listContacts();
    console.log('Starting stored contacts refresh after DM startup EOSE', {
      contactCount: storedContacts.length,
    });
    if (storedContacts.length === 0) {
      return {
        totalCount: 0,
        refreshedCount: 0,
        failedCount: 0,
        cursorContactCount: 0,
        cursorAppliedCount: 0,
        cursorUiReloaded: false,
      };
    }

    let refreshedCount = 0;
    let failedCount = 0;

    for (const contact of storedContacts) {
      const fallbackName = contact.name.trim() || contact.public_key.slice(0, 16);
      try {
        await refreshContactByPublicKey(contact.public_key, fallbackName);
        refreshedCount += 1;
      } catch (error) {
        failedCount += 1;
        console.warn(
          'Failed to refresh stored contact after DM startup EOSE',
          contact.public_key,
          error
        );
      }
    }

    const refreshedContacts = await contactsService.listContacts();
    let cursorAppliedCount = 0;
    let cursorUiReloaded = false;
    if (readPrivatePreferencesFromStorage() && refreshedContacts.length > 0) {
      console.log('Starting per-contact cursor data refresh after DM startup EOSE', {
        contactCount: refreshedContacts.length,
      });
      const cursorsByDTag = await fetchContactCursorEvents(refreshedContacts);
      for (const contact of refreshedContacts) {
        const contactDTag = await deriveContactCursorDTag(contact.public_key);
        if (!contactDTag) {
          continue;
        }

        const cursor = cursorsByDTag.get(contactDTag);
        if (!cursor) {
          continue;
        }

        if (await applyContactCursorStateToContact(contact, cursor)) {
          cursorAppliedCount += 1;
        }
      }

      if (cursorAppliedCount > 0) {
        console.log('Starting UI refresh after per-contact cursor data refresh', {
          cursorAppliedCount,
        });
        const { useMessageStore } = await import('src/stores/messageStore');
        await Promise.all([reloadChats(), useMessageStore().reloadLoadedMessages()]);
        cursorUiReloaded = true;
      }
    }

    bumpContactListVersion();

    return {
      totalCount: storedContacts.length,
      refreshedCount,
      failedCount,
      cursorContactCount: refreshedContacts.length,
      cursorAppliedCount,
      cursorUiReloaded,
    };
  }

  async function syncLoggedInContactProfile(relayUrls: string[]): Promise<void> {
    const existingPromise = getSyncLoggedInContactProfilePromise();
    if (existingPromise) {
      return existingPromise;
    }

    const nextPromise = (async () => {
      const loggedInPubkeyHex = getLoggedInPublicKeyHex();
      if (!loggedInPubkeyHex) {
        return;
      }

      const activeRelays = inputSanitizerService.normalizeStringArray(relayUrls);
      if (activeRelays.length > 0) {
        try {
          await ensureRelayConnections(activeRelays);
        } catch (error) {
          console.warn('Failed to connect relays before profile sync', error);
        }
      }

      const profileTracker = createStartupBatchTracker('logged-in-profile');
      const relayTracker = createStartupBatchTracker('logged-in-relays');
      try {
        await refreshContactByPublicKey(loggedInPubkeyHex, '', {
          onProfileFetchStart: () => {
            profileTracker.beginItem();
          },
          onProfileFetchEnd: (error) => {
            profileTracker.finishItem(error ?? undefined);
          },
          onRelayFetchStart: () => {
            relayTracker.beginItem();
          },
          onRelayFetchEnd: (error) => {
            relayTracker.finishItem(error ?? undefined);
          },
        });
      } catch (error) {
        profileTracker.finishItem(error);
        relayTracker.finishItem(error);
        console.warn('Failed to refresh logged-in contact profile', error);
      } finally {
        profileTracker.seal();
        relayTracker.seal();
      }
    })().finally(() => {
      setSyncLoggedInContactProfilePromise(null);
    });

    setSyncLoggedInContactProfilePromise(nextPromise);
    return nextPromise;
  }

  async function syncRecentChatContacts(relayUrls: string[]): Promise<void> {
    const existingPromise = getSyncRecentChatContactsPromise();
    if (existingPromise) {
      return existingPromise;
    }

    const nextPromise = (async () => {
      const profileTracker = createStartupBatchTracker('recent-chat-profiles');
      const relayTracker = createStartupBatchTracker('recent-chat-relays');
      try {
        const activeRelays = inputSanitizerService.normalizeStringArray(relayUrls);
        if (activeRelays.length > 0) {
          try {
            await ensureRelayConnections(activeRelays);
          } catch (error) {
            console.warn('Failed to connect relays before syncing recent chat contacts', error);
          }
        }

        await Promise.all([chatDataService.init(), contactsService.init()]);
        const recentChats = await chatDataService.listChats();
        if (recentChats.length === 0) {
          return;
        }

        const loggedInPubkeyHex = getLoggedInPublicKeyHex();
        const recentPublicKeys = new Set<string>();

        for (const chat of recentChats) {
          const normalizedPubkey = inputSanitizerService.normalizeHexKey(chat.public_key);
          if (!normalizedPubkey) {
            continue;
          }

          if (loggedInPubkeyHex && normalizedPubkey === loggedInPubkeyHex) {
            continue;
          }

          recentPublicKeys.add(normalizedPubkey);
        }

        if (recentPublicKeys.size === 0) {
          return;
        }

        for (const pubkeyHex of recentPublicKeys) {
          const existingContact = await contactsService.getContactByPublicKey(pubkeyHex);
          if (!existingContact) {
            continue;
          }

          const matchingChat = recentChats.find(
            (chat) => inputSanitizerService.normalizeHexKey(chat.public_key) === pubkeyHex
          );
          const fallbackName = existingContact.name.trim() || matchingChat?.name?.trim() || '';
          try {
            await refreshContactByPublicKey(pubkeyHex, fallbackName, {
              onProfileFetchStart: () => {
                profileTracker.beginItem();
              },
              onProfileFetchEnd: (error) => {
                profileTracker.finishItem(error ?? undefined);
              },
              onRelayFetchStart: () => {
                relayTracker.beginItem();
              },
              onRelayFetchEnd: (error) => {
                relayTracker.finishItem(error ?? undefined);
              },
            });
          } catch (error) {
            profileTracker.finishItem(error);
            relayTracker.finishItem(error);
            console.warn('Failed to refresh recent chat contact profile', pubkeyHex, error);
          }
        }
      } finally {
        profileTracker.seal();
        relayTracker.seal();
      }
    })().finally(() => {
      setSyncRecentChatContactsPromise(null);
    });

    setSyncRecentChatContactsPromise(nextPromise);
    return nextPromise;
  }

  async function runStartupTaskBody(
    stepId: StartupStepId,
    seedRelayUrls: string[],
    options: StartupTaskRunOptions
  ): Promise<void> {
    const forceSubscriptions = options.forceSubscriptions === true;

    switch (stepId) {
      case 'my-relays-restore':
        await restoreMyRelayList(seedRelayUrls);
        return;
      case 'my-relays-subscribe':
        await subscribeMyRelayListUpdates(seedRelayUrls, forceSubscriptions);
        return;
      case 'outbound-message-replay':
        await startOutboundMessageReplay();
        return;
      case 'private-preferences':
        await restorePrivatePreferences(seedRelayUrls);
        return;
      case 'private-contact-list-restore':
        await restorePrivateContactList(seedRelayUrls);
        return;
      case 'group-identity-secrets':
        await restoreGroupIdentitySecrets(seedRelayUrls);
        return;
      case 'group-relay-lists-refresh':
        await refreshGroupRelayListsOnStartup(seedRelayUrls);
        return;
      case 'contact-cursor-state':
        await restoreMuteList(seedRelayUrls);
        await restoreContactCursorState(seedRelayUrls);
        return;
      case 'logged-in-contact-profile':
        await syncLoggedInContactProfile(seedRelayUrls);
        return;
      case 'recent-chat-contacts-sync':
        await syncRecentChatContacts(seedRelayUrls);
        return;
      case 'private-contact-list-subscribe':
        await subscribePrivateContactListUpdates(seedRelayUrls, forceSubscriptions);
        return;
      case 'private-messages-subscribe':
        await subscribePrivateMessagesForLoggedInUser(true, {
          restoreThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
          startupTrackStep: true,
        });
        return;
      case 'group-rosters-subscribe':
        await subscribeGroupMembershipRosterUpdates(seedRelayUrls, forceSubscriptions);
        return;
      case 'contact-profile-subscribe':
        await subscribeContactProfileUpdates(seedRelayUrls, forceSubscriptions);
        return;
      case 'contact-relay-list-subscribe':
        await subscribeContactRelayListUpdates(seedRelayUrls, forceSubscriptions);
        return;
    }
  }

  async function runStartupTask(
    stepId: StartupStepId,
    seedRelayUrls: string[],
    options: StartupTaskRunOptions = {}
  ): Promise<boolean> {
    const taskStartedAt = Date.now();
    if (options.resetStep === true) {
      resetStartupStep(stepId);
    }

    beginStartupStep(stepId);
    logStartupRestore('task-start', {
      task: stepId,
    });
    try {
      await yieldToMainThread();
      await runStartupTaskBody(stepId, seedRelayUrls, options);
      if (stepId !== 'private-messages-subscribe') {
        completeStartupStep(stepId);
      }
      logStartupRestore('task-complete', {
        task: stepId,
        durationMs: Date.now() - taskStartedAt,
      });
      return true;
    } catch (error) {
      failStartupStep(stepId, error);
      const reportError = isExpectedRelayQueryDeferral(error) ? console.warn : console.error;
      reportError(STARTUP_TASK_ERROR_MESSAGES[stepId], error);
      logStartupRestore('task-error', {
        task: stepId,
        durationMs: Date.now() - taskStartedAt,
        error: formatStartupRestoreError(error),
      });

      if (options.propagateError === true) {
        throw error;
      }

      return false;
    }
  }

  async function rerunStartupStep(
    stepId: StartupStepId,
    seedRelayUrls: string[] = []
  ): Promise<void> {
    ensureStoredEventSince();
    await runStartupTask(stepId, seedRelayUrls, {
      forceSubscriptions: true,
      propagateError: true,
      resetStep: true,
    });
  }

  async function restoreStartupState(seedRelayUrls: string[] = []): Promise<void> {
    const existingPromise = getRestoreStartupStatePromise();
    if (existingPromise) {
      logStartupRestore('reuse-existing', {
        hasLoggedInPubkey: Boolean(getLoggedInPublicKeyHex()),
        seedRelayCount: seedRelayUrls.length,
      });
      return existingPromise;
    }

    ensureStoredEventSince();
    resetStartupStepTracking();
    const startupRestoreStartedAt = Date.now();
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    const checkpointRelayUrls = getCheckpointRelayUrls(seedRelayUrls);
    if (loggedInPubkeyHex) {
      writeStartupCheckpoint(loggedInPubkeyHex, checkpointRelayUrls, 'in_progress');
    }

    isRestoringStartupState.value = true;
    logStartupRestore('start', {
      hasLoggedInPubkey: Boolean(getLoggedInPublicKeyHex()),
      seedRelayCount: seedRelayUrls.length,
    });
    const nextPromise = (async () => {
      let didCompleteEveryTask = true;
      try {
        for (const stepId of STARTUP_RESTORE_STEP_ORDER) {
          didCompleteEveryTask =
            (await runStartupTask(stepId, seedRelayUrls)) && didCompleteEveryTask;
        }
      } finally {
        isRestoringStartupState.value = false;
        flushPendingEventSinceUpdate();
        setRestoreStartupStatePromise(null);
        if (loggedInPubkeyHex) {
          const finalCheckpoint = writeStartupCheckpoint(
            loggedInPubkeyHex,
            getCheckpointRelayUrls(seedRelayUrls),
            didCompleteEveryTask ? 'complete' : 'failed'
          );
          initializedSessionPubkey =
            finalCheckpoint?.status === 'complete' ? loggedInPubkeyHex : null;
        }
        logStartupRestore('complete', {
          durationMs: Date.now() - startupRestoreStartedAt,
          success: didCompleteEveryTask,
        });
      }
    })();

    setRestoreStartupStatePromise(nextPromise);
    return nextPromise;
  }

  async function initializeSessionState(seedRelayUrls: string[] = []): Promise<void> {
    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      await restoreStartupState(seedRelayUrls);
      return;
    }

    if (initializedSessionPubkey === loggedInPubkeyHex) {
      return;
    }

    if (initializeSessionStatePromise) {
      return initializeSessionStatePromise;
    }

    initializeSessionStatePromise = (async () => {
      const checkpointRelayUrls = getCheckpointRelayUrls(seedRelayUrls);
      const checkpoint = readStartupCheckpoint();
      if (!isStartupCheckpointCurrent(checkpoint, loggedInPubkeyHex, checkpointRelayUrls)) {
        await restoreStartupState(seedRelayUrls);
        return;
      }

      ensureStoredEventSince();
      logStartupRestore('lightweight-resume-start', {
        relayCount: checkpointRelayUrls.length,
      });
      try {
        await runLightweightSessionResume(checkpointRelayUrls);
        initializedSessionPubkey = loggedInPubkeyHex;
        logStartupRestore('lightweight-resume-complete', {
          relayCount: checkpointRelayUrls.length,
        });
      } catch (error) {
        writeStartupCheckpoint(loggedInPubkeyHex, checkpointRelayUrls, 'failed');
        logStartupRestore('lightweight-resume-fallback', {
          error: formatStartupRestoreError(error),
        });
        await restoreStartupState(seedRelayUrls);
      }
    })().finally(() => {
      initializeSessionStatePromise = null;
    });

    return initializeSessionStatePromise;
  }

  function resetStartupSessionInitialization(): void {
    initializeSessionStatePromise = null;
    initializedSessionPubkey = null;
  }

  return {
    initializeSessionState,
    refreshAllStoredContacts,
    resetStartupSessionInitialization,
    rerunStartupStep,
    restoreStartupState,
    syncLoggedInContactProfile,
    syncRecentChatContacts,
  };
}
