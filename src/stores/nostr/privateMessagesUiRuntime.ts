import { chatDataService } from '#src/services/chatDataService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { QueuePrivateMessageUiRefreshOptions } from '#src/stores/nostr/types.ts';

interface PrivateMessagesUiRuntimeDeps {
  chatStore: {
    reload: () => Promise<void>;
  };
  normalizeThrottleMs: (value: number | undefined) => number;
  refreshDeveloperPendingQueues: () => Promise<void>;
  waitForPrivateMessagesIngestQueue: () => Promise<void>;
}

export function createPrivateMessagesUiRuntime({
  chatStore,
  normalizeThrottleMs,
  refreshDeveloperPendingQueues,
  waitForPrivateMessagesIngestQueue,
}: PrivateMessagesUiRuntimeDeps) {
  let privateMessagesUiRefreshQueue = Promise.resolve();
  let privateMessagesUiRefreshTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let shouldReloadChatsOnPrivateMessagesUiRefresh = false;
  let shouldReloadMessagesOnPrivateMessagesUiRefresh = false;
  let chatChecksQueue = Promise.resolve();
  let postPrivateMessagesEoseChecksQueue = Promise.resolve();
  let postPrivateMessagesEoseChecksTimeoutId: ReturnType<typeof globalThis.setTimeout> | null =
    null;
  let shouldRunPostPrivateMessagesEoseChecks = false;
  let chatChecksTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let shouldRunChatChecksForAllChats = false;
  const pendingChatCheckChatIds = new Set<string>();

  async function flushPrivateMessagesUiRefresh(): Promise<void> {
    const shouldReloadChats = shouldReloadChatsOnPrivateMessagesUiRefresh;
    const shouldReloadMessages = shouldReloadMessagesOnPrivateMessagesUiRefresh;
    shouldReloadChatsOnPrivateMessagesUiRefresh = false;
    shouldReloadMessagesOnPrivateMessagesUiRefresh = false;

    if (!shouldReloadChats && !shouldReloadMessages) {
      return;
    }

    try {
      const tasks: Promise<unknown>[] = [];

      if (shouldReloadChats) {
        tasks.push(chatStore.reload());
      }

      if (shouldReloadMessages) {
        const { useMessageStore } = await import('#src/stores/messageStore.ts');
        tasks.push(useMessageStore().reloadLoadedMessages());
      }

      await Promise.all(tasks);
    } catch (error) {
      console.error('Failed to flush private message UI refresh', error);
    }
  }

  function queuePrivateMessagesUiRefresh(options: QueuePrivateMessageUiRefreshOptions = {}): void {
    if (options.reloadChats) {
      shouldReloadChatsOnPrivateMessagesUiRefresh = true;
    }

    if (options.reloadMessages) {
      shouldReloadMessagesOnPrivateMessagesUiRefresh = true;
    }

    const throttleMs = normalizeThrottleMs(options.throttleMs);
    if (throttleMs <= 0) {
      privateMessagesUiRefreshQueue = privateMessagesUiRefreshQueue.then(() =>
        flushPrivateMessagesUiRefresh()
      );
      return;
    }

    if (privateMessagesUiRefreshTimeoutId !== null) {
      return;
    }

    privateMessagesUiRefreshTimeoutId = globalThis.setTimeout(() => {
      privateMessagesUiRefreshTimeoutId = null;
      privateMessagesUiRefreshQueue = privateMessagesUiRefreshQueue.then(() =>
        flushPrivateMessagesUiRefresh()
      );
    }, throttleMs);
  }

  function flushPrivateMessagesUiRefreshNow(): void {
    if (privateMessagesUiRefreshTimeoutId !== null) {
      globalThis.clearTimeout(privateMessagesUiRefreshTimeoutId);
      privateMessagesUiRefreshTimeoutId = null;
    }

    privateMessagesUiRefreshQueue = privateMessagesUiRefreshQueue.then(() =>
      flushPrivateMessagesUiRefresh()
    );
  }

  async function runPendingChatChecks(): Promise<void> {
    try {
      await chatDataService.init();
      let chatIds: string[] = [];

      if (shouldRunChatChecksForAllChats) {
        const chatRows = await chatDataService.listChats();
        chatIds = chatRows
          .map((row) => inputSanitizerService.normalizeHexKey(row.public_key))
          .filter((value): value is string => Boolean(value));
      } else {
        chatIds = Array.from(pendingChatCheckChatIds);
      }

      shouldRunChatChecksForAllChats = false;
      pendingChatCheckChatIds.clear();

      if (chatIds.length === 0) {
        return;
      }

      await chatStore.reload();
      const { useMessageStore } = await import('#src/stores/messageStore.ts');
      const messageStore = useMessageStore();

      for (const chatId of chatIds) {
        try {
          await messageStore.syncChatUnseenReactionCount(chatId);
        } catch (error) {
          console.warn('Failed to sync unseen reaction count during chat checks', chatId, error);
        }
      }

      await messageStore.reloadLoadedMessages();
    } catch (error) {
      console.error('Failed to run chat checks', error);
    }
  }

  function scheduleChatChecks(chatIds: string[] = [], options: { allChats?: boolean } = {}): void {
    if (options.allChats) {
      shouldRunChatChecksForAllChats = true;
      pendingChatCheckChatIds.clear();
    } else if (!shouldRunChatChecksForAllChats) {
      for (const chatId of chatIds) {
        const normalizedChatId = inputSanitizerService.normalizeHexKey(chatId);
        if (normalizedChatId) {
          pendingChatCheckChatIds.add(normalizedChatId);
        }
      }
    }

    if (chatChecksTimeoutId !== null) {
      return;
    }

    chatChecksTimeoutId = globalThis.setTimeout(() => {
      chatChecksTimeoutId = null;
      chatChecksQueue = chatChecksQueue.then(() => runPendingChatChecks());
    }, 0);
  }

  function schedulePostPrivateMessagesEoseChecks(): void {
    shouldRunPostPrivateMessagesEoseChecks = true;
    if (postPrivateMessagesEoseChecksTimeoutId !== null) {
      return;
    }

    postPrivateMessagesEoseChecksTimeoutId = globalThis.setTimeout(() => {
      postPrivateMessagesEoseChecksTimeoutId = null;
      if (!shouldRunPostPrivateMessagesEoseChecks) {
        return;
      }

      shouldRunPostPrivateMessagesEoseChecks = false;
      postPrivateMessagesEoseChecksQueue = postPrivateMessagesEoseChecksQueue
        .then(async () => {
          try {
            await waitForPrivateMessagesIngestQueue();
            await refreshDeveloperPendingQueues();
            const { useMessageStore } = await import('#src/stores/messageStore.ts');
            await useMessageStore().syncChatsReadStateFromSeenBoundary();
            scheduleChatChecks([], { allChats: true });
          } catch (error) {
            console.error('Failed to run post-DM EOSE checks', error);
          }
        })
        .catch((error) => {
          console.error('Failed to enqueue post-DM EOSE checks', error);
        });
    }, 0);
  }

  function clearPrivateMessagesUiRefreshState(): void {
    if (privateMessagesUiRefreshTimeoutId !== null) {
      globalThis.clearTimeout(privateMessagesUiRefreshTimeoutId);
      privateMessagesUiRefreshTimeoutId = null;
    }

    shouldReloadChatsOnPrivateMessagesUiRefresh = false;
    shouldReloadMessagesOnPrivateMessagesUiRefresh = false;
  }

  function resetPrivateMessagesUiRuntimeState(
    options: { includeRefreshQueue?: boolean } = {}
  ): void {
    clearPrivateMessagesUiRefreshState();

    if (chatChecksTimeoutId !== null) {
      globalThis.clearTimeout(chatChecksTimeoutId);
      chatChecksTimeoutId = null;
    }
    if (postPrivateMessagesEoseChecksTimeoutId !== null) {
      globalThis.clearTimeout(postPrivateMessagesEoseChecksTimeoutId);
      postPrivateMessagesEoseChecksTimeoutId = null;
    }

    shouldRunChatChecksForAllChats = false;
    shouldRunPostPrivateMessagesEoseChecks = false;
    pendingChatCheckChatIds.clear();
    chatChecksQueue = Promise.resolve();
    postPrivateMessagesEoseChecksQueue = Promise.resolve();

    if (options.includeRefreshQueue) {
      privateMessagesUiRefreshQueue = Promise.resolve();
    }
  }

  return {
    clearPrivateMessagesUiRefreshState,
    flushPrivateMessagesUiRefreshNow,
    queuePrivateMessagesUiRefresh,
    resetPrivateMessagesUiRuntimeState,
    scheduleChatChecks,
    schedulePostPrivateMessagesEoseChecks,
  };
}
