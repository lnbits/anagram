import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const chatDataServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listChats: vi.fn(async () => []),
}));

const contactsServiceMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listContacts: vi.fn(async () => []),
  getContactByPublicKey: vi.fn(async () => null),
}));

vi.mock('src/services/chatDataService', () => ({
  chatDataService: chatDataServiceMock,
}));

vi.mock('src/services/contactsService', () => ({
  contactsService: contactsServiceMock,
}));

import { PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS } from 'src/stores/nostr/constants';
import { RelayQueryTimeoutError } from 'src/stores/nostr/relayQueryUtils';
import { writeStartupCheckpoint } from 'src/stores/nostr/startupCheckpoint';
import { createStartupContactSyncRuntime } from 'src/stores/nostr/startupContactSyncRuntime';

const PUBKEY = 'a'.repeat(64);

function installLocalStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

function createSessionInitializationRuntime(
  options: { restoreMyRelayListError?: Error; resumeError?: Error } = {}
) {
  let restoreStartupStatePromise: Promise<void> | null = null;
  let syncLoggedInContactProfilePromise: Promise<void> | null = null;
  let syncRecentChatContactsPromise: Promise<void> | null = null;
  const beginStartupStep = vi.fn();
  const runLightweightSessionResume = options.resumeError
    ? vi.fn(async () => {
        throw options.resumeError;
      })
    : vi.fn(async () => {});
  const task = () => vi.fn(async () => {});
  const restoreMyRelayList = options.restoreMyRelayListError
    ? vi.fn(async () => {
        throw options.restoreMyRelayListError;
      })
    : task();

  const runtime = createStartupContactSyncRuntime({
    applyContactCursorStateToContact: vi.fn(async () => false),
    beginStartupStep,
    bumpContactListVersion: vi.fn(),
    completeStartupStep: vi.fn(),
    createStartupBatchTracker: vi.fn(() => ({
      beginItem: vi.fn(),
      finishItem: vi.fn(),
      seal: vi.fn(),
    })),
    deriveContactCursorDTag: vi.fn(async () => null),
    ensureRelayConnections: vi.fn(async () => {}),
    ensureStoredEventSince: vi.fn(),
    fetchContactCursorEvents: vi.fn(async () => new Map()),
    failStartupStep: vi.fn(),
    flushPendingEventSinceUpdate: vi.fn(),
    getConfiguredRelayUrls: vi.fn(() => ['wss://relay.one/']),
    getLoggedInPublicKeyHex: vi.fn(() => PUBKEY),
    getRestoreStartupStatePromise: () => restoreStartupStatePromise,
    getSyncLoggedInContactProfilePromise: () => syncLoggedInContactProfilePromise,
    getSyncRecentChatContactsPromise: () => syncRecentChatContactsPromise,
    isRestoringStartupState: ref(false),
    readPrivatePreferencesFromStorage: vi.fn(() => null),
    reloadChats: vi.fn(async () => {}),
    refreshContactByPublicKey: task(),
    refreshGroupRelayListsOnStartup: task(),
    resetStartupStep: vi.fn(),
    resetStartupStepTracking: vi.fn(),
    restoreContactCursorState: task(),
    restoreGroupIdentitySecrets: task(),
    restoreMyRelayList,
    restoreMuteList: task(),
    restorePrivateContactList: task(),
    restorePrivatePreferences: task(),
    runLightweightSessionResume,
    startOutboundMessageReplay: task(),
    setRestoreStartupStatePromise: (promise) => {
      restoreStartupStatePromise = promise;
    },
    setSyncLoggedInContactProfilePromise: (promise) => {
      syncLoggedInContactProfilePromise = promise;
    },
    setSyncRecentChatContactsPromise: (promise) => {
      syncRecentChatContactsPromise = promise;
    },
    subscribeContactProfileUpdates: task(),
    subscribeContactRelayListUpdates: task(),
    subscribeGroupMembershipRosterUpdates: task(),
    subscribeMyRelayListUpdates: task(),
    subscribePrivateContactListUpdates: task(),
    subscribePrivateMessagesForLoggedInUser: task(),
  });

  return {
    beginStartupStep,
    runLightweightSessionResume,
    runtime,
  };
}

describe('startup contact sync runtime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs startup restore tasks in dependency order', async () => {
    const taskOrder: string[] = [];
    let restoreStartupStatePromise: Promise<void> | null = null;
    let syncLoggedInContactProfilePromise: Promise<void> | null = null;
    let syncRecentChatContactsPromise: Promise<void> | null = null;

    const task = (label: string) =>
      vi.fn(async () => {
        taskOrder.push(label);
      });
    const subscribePrivateMessagesForLoggedInUser = task('private-messages-subscribe');
    const refreshContactByPublicKey = vi.fn(async () => {
      taskOrder.push('logged-in-contact-profile');
    });

    chatDataServiceMock.listChats.mockImplementationOnce(async () => {
      taskOrder.push('recent-chat-contacts-sync');
      return [];
    });

    const runtime = createStartupContactSyncRuntime({
      applyContactCursorStateToContact: vi.fn(async () => false),
      beginStartupStep: vi.fn(),
      bumpContactListVersion: vi.fn(),
      completeStartupStep: vi.fn(),
      createStartupBatchTracker: vi.fn(() => ({
        beginItem: vi.fn(),
        finishItem: vi.fn(),
        seal: vi.fn(),
      })),
      deriveContactCursorDTag: vi.fn(async () => null),
      ensureRelayConnections: vi.fn(async () => {}),
      ensureStoredEventSince: vi.fn(),
      fetchContactCursorEvents: vi.fn(async () => new Map()),
      failStartupStep: vi.fn(),
      flushPendingEventSinceUpdate: vi.fn(),
      getConfiguredRelayUrls: vi.fn(() => ['wss://relay.one/']),
      getLoggedInPublicKeyHex: vi.fn(() => PUBKEY),
      getRestoreStartupStatePromise: () => restoreStartupStatePromise,
      getSyncLoggedInContactProfilePromise: () => syncLoggedInContactProfilePromise,
      getSyncRecentChatContactsPromise: () => syncRecentChatContactsPromise,
      isRestoringStartupState: ref(false),
      readPrivatePreferencesFromStorage: vi.fn(() => null),
      reloadChats: vi.fn(async () => {}),
      refreshContactByPublicKey,
      refreshGroupRelayListsOnStartup: task('group-relay-lists-refresh'),
      resetStartupStep: vi.fn(),
      resetStartupStepTracking: vi.fn(),
      restoreContactCursorState: task('contact-cursor-state'),
      restoreGroupIdentitySecrets: task('group-identity-secrets'),
      restoreMyRelayList: task('my-relays-restore'),
      restoreMuteList: task('mute-list'),
      restorePrivateContactList: task('private-contact-list-restore'),
      restorePrivatePreferences: task('private-preferences'),
      runLightweightSessionResume: vi.fn(async () => {}),
      startOutboundMessageReplay: task('outbound-message-replay'),
      setRestoreStartupStatePromise: (promise) => {
        restoreStartupStatePromise = promise;
      },
      setSyncLoggedInContactProfilePromise: (promise) => {
        syncLoggedInContactProfilePromise = promise;
      },
      setSyncRecentChatContactsPromise: (promise) => {
        syncRecentChatContactsPromise = promise;
      },
      subscribeContactProfileUpdates: task('contact-profile-subscribe'),
      subscribeContactRelayListUpdates: task('contact-relay-list-subscribe'),
      subscribeGroupMembershipRosterUpdates: task('group-rosters-subscribe'),
      subscribeMyRelayListUpdates: task('my-relays-subscribe'),
      subscribePrivateContactListUpdates: task('private-contact-list-subscribe'),
      subscribePrivateMessagesForLoggedInUser,
    });

    await runtime.restoreStartupState();

    expect(taskOrder).toEqual([
      'my-relays-restore',
      'my-relays-subscribe',
      'outbound-message-replay',
      'private-preferences',
      'private-contact-list-restore',
      'group-identity-secrets',
      'group-relay-lists-refresh',
      'mute-list',
      'contact-cursor-state',
      'logged-in-contact-profile',
      'recent-chat-contacts-sync',
      'private-contact-list-subscribe',
      'private-messages-subscribe',
      'group-rosters-subscribe',
      'contact-profile-subscribe',
      'contact-relay-list-subscribe',
    ]);
    expect(subscribePrivateMessagesForLoggedInUser).toHaveBeenCalledWith(true, {
      restoreThrottleMs: PRIVATE_MESSAGES_STARTUP_RESTORE_THROTTLE_MS,
      startupTrackStep: true,
    });
  });

  it('reruns one startup step without resetting the full startup history', async () => {
    const taskOrder: string[] = [];
    let restoreStartupStatePromise: Promise<void> | null = null;
    let syncLoggedInContactProfilePromise: Promise<void> | null = null;
    let syncRecentChatContactsPromise: Promise<void> | null = null;

    const task = (label: string) =>
      vi.fn(async () => {
        taskOrder.push(label);
      });
    const beginStartupStep = vi.fn();
    const completeStartupStep = vi.fn();
    const resetStartupStep = vi.fn();
    const resetStartupStepTracking = vi.fn();
    const subscribeMyRelayListUpdates = task('my-relays-subscribe');

    const runtime = createStartupContactSyncRuntime({
      applyContactCursorStateToContact: vi.fn(async () => false),
      beginStartupStep,
      bumpContactListVersion: vi.fn(),
      completeStartupStep,
      createStartupBatchTracker: vi.fn(() => ({
        beginItem: vi.fn(),
        finishItem: vi.fn(),
        seal: vi.fn(),
      })),
      deriveContactCursorDTag: vi.fn(async () => null),
      ensureRelayConnections: vi.fn(async () => {}),
      ensureStoredEventSince: vi.fn(),
      fetchContactCursorEvents: vi.fn(async () => new Map()),
      failStartupStep: vi.fn(),
      flushPendingEventSinceUpdate: vi.fn(),
      getConfiguredRelayUrls: vi.fn(() => ['wss://relay.one/']),
      getLoggedInPublicKeyHex: vi.fn(() => PUBKEY),
      getRestoreStartupStatePromise: () => restoreStartupStatePromise,
      getSyncLoggedInContactProfilePromise: () => syncLoggedInContactProfilePromise,
      getSyncRecentChatContactsPromise: () => syncRecentChatContactsPromise,
      isRestoringStartupState: ref(false),
      readPrivatePreferencesFromStorage: vi.fn(() => null),
      reloadChats: vi.fn(async () => {}),
      refreshContactByPublicKey: vi.fn(async () => {}),
      refreshGroupRelayListsOnStartup: task('group-relay-lists-refresh'),
      resetStartupStep,
      resetStartupStepTracking,
      restoreContactCursorState: task('contact-cursor-state'),
      restoreGroupIdentitySecrets: task('group-identity-secrets'),
      restoreMyRelayList: task('my-relays-restore'),
      restoreMuteList: task('mute-list'),
      restorePrivateContactList: task('private-contact-list-restore'),
      restorePrivatePreferences: task('private-preferences'),
      runLightweightSessionResume: vi.fn(async () => {}),
      startOutboundMessageReplay: task('outbound-message-replay'),
      setRestoreStartupStatePromise: (promise) => {
        restoreStartupStatePromise = promise;
      },
      setSyncLoggedInContactProfilePromise: (promise) => {
        syncLoggedInContactProfilePromise = promise;
      },
      setSyncRecentChatContactsPromise: (promise) => {
        syncRecentChatContactsPromise = promise;
      },
      subscribeContactProfileUpdates: task('contact-profile-subscribe'),
      subscribeContactRelayListUpdates: task('contact-relay-list-subscribe'),
      subscribeGroupMembershipRosterUpdates: task('group-rosters-subscribe'),
      subscribeMyRelayListUpdates,
      subscribePrivateContactListUpdates: task('private-contact-list-subscribe'),
      subscribePrivateMessagesForLoggedInUser: task('private-messages-subscribe'),
    });

    await runtime.rerunStartupStep('my-relays-subscribe', ['wss://relay.one/']);

    expect(taskOrder).toEqual(['my-relays-subscribe']);
    expect(resetStartupStep).toHaveBeenCalledWith('my-relays-subscribe');
    expect(resetStartupStepTracking).not.toHaveBeenCalled();
    expect(beginStartupStep).toHaveBeenCalledWith('my-relays-subscribe');
    expect(subscribeMyRelayListUpdates).toHaveBeenCalledWith(['wss://relay.one/'], true);
    expect(completeStartupStep).toHaveBeenCalledWith('my-relays-subscribe');
  });

  it('uses a completed checkpoint for one lightweight resume per runtime', async () => {
    installLocalStorage();
    writeStartupCheckpoint(PUBKEY, ['wss://relay.one/'], 'complete');
    const { beginStartupStep, runLightweightSessionResume, runtime } =
      createSessionInitializationRuntime();

    await runtime.initializeSessionState(['wss://relay.one/']);
    await runtime.initializeSessionState(['wss://relay.one/']);

    expect(runLightweightSessionResume).toHaveBeenCalledTimes(1);
    expect(runLightweightSessionResume).toHaveBeenCalledWith(['wss://relay.one/']);
    expect(beginStartupStep).not.toHaveBeenCalled();
  });

  it('falls back to a full restore when lightweight resume fails', async () => {
    installLocalStorage();
    writeStartupCheckpoint(PUBKEY, ['wss://relay.one/'], 'complete');
    const { beginStartupStep, runLightweightSessionResume, runtime } =
      createSessionInitializationRuntime({
        resumeError: new Error('resume failed'),
      });

    await runtime.initializeSessionState(['wss://relay.one/']);

    expect(runLightweightSessionResume).toHaveBeenCalledTimes(1);
    expect(beginStartupStep).toHaveBeenCalledWith('my-relays-restore');
    expect(beginStartupStep).toHaveBeenCalledWith('private-messages-subscribe');
  });

  it('reports a bounded relay-query deferral as a warning during startup', async () => {
    const queryError = new RelayQueryTimeoutError(2_500);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { runtime } = createSessionInitializationRuntime({
      restoreMyRelayListError: queryError,
    });

    await runtime.restoreStartupState();

    expect(warnSpy).toHaveBeenCalledWith('Failed to restore My Relays on startup', queryError);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
