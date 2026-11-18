import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';
import { isIosNative } from '#src/lib/platform/ios.ts';
import { notificationConversationId } from '#src/utils/notificationConversation.ts';

export function isDesktopNative(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    !/Android/i.test(navigator.userAgent) &&
    !isIosNative()
  );
}

export async function showDesktopMessageNotification(input: {
  ownerPubkey: string;
  chatPubkey: string;
  title: string;
  body: string;
}): Promise<void> {
  if (!isDesktopNative()) return;
  // Await the plugin command so delivery errors are caught instead of becoming
  // unhandled rejections in the plugin's fire-and-forget Notification shim.
  await invoke('plugin:notification|notify', {
    options: {
      title: input.title,
      body: input.body,
      extra: { ownerPubkey: input.ownerPubkey, chatPubkey: input.chatPubkey },
    },
  });
}

type NotificationAction = {
  actionId?: string;
  notification?: { extra?: { ownerPubkey?: unknown; chatPubkey?: unknown } };
};

export function startDesktopNotificationListener(
  getOwnerPubkey: () => string | null,
  openChat: (chatPubkey: string) => void,
): () => void {
  if (!isDesktopNative()) return () => {};
  let active = true;
  const ownerPubkey = getOwnerPubkey();
  const isCurrent = () => active && Boolean(ownerPubkey) && getOwnerPubkey() === ownerPubkey;
  const reportError = (error: unknown) => console.warn('Desktop notification action failed', error);
  async function open(action: NotificationAction) {
    const extra = action.notification?.extra;
    if (
      !isCurrent() ||
      action.actionId !== 'tap' ||
      extra?.ownerPubkey !== ownerPubkey ||
      typeof extra.chatPubkey !== 'string'
    )
      return;
    const chatPubkey = notificationConversationId(extra.chatPubkey);
    if (!chatPubkey) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    if (!isCurrent()) return;
    const currentWindow = getCurrentWindow();
    await currentWindow.unminimize();
    await currentWindow.show();
    await currentWindow.setFocus();
    if (isCurrent()) openChat(chatPubkey);
  }
  const listener = addPluginListener<NotificationAction>(
    'notification',
    'actionPerformed',
    (action) => {
      void open(action).catch(reportError);
    },
  );
  // Cleanup also covers unmount/logout before native registration resolves.
  void listener.catch(reportError);
  return () => {
    if (!active) return;
    active = false;
    void listener.then((handle) => handle.unregister()).catch(reportError);
  };
}
