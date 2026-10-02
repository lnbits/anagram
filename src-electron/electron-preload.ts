import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopRuntime', {
  isElectron: true,
  onCallScreenPicker: (listener: (request: { id: string; sources: Array<{ id: string; name: string; thumbnail: string }> } | null) => void) => {
    const handler = (_event: unknown, request: { id: string; sources: Array<{ id: string; name: string; thumbnail: string }> } | null) => listener(request);
    ipcRenderer.on('desktop:call-screen-picker', handler);
    return () => ipcRenderer.removeListener('desktop:call-screen-picker', handler);
  },
  selectCallScreen: (id: string, sourceId: string | null) => ipcRenderer.send('desktop:call-screen-selected', { id, sourceId }),
  platform: process.platform,
  isSecureStorageAvailable: async () => {
    return Boolean(await ipcRenderer.invoke('desktop:secure-storage:is-available'));
  },
  encryptPrivateKey: async (privateKeyHex: string) => {
    const result = await ipcRenderer.invoke(
      'desktop:secure-storage:encrypt-private-key',
      privateKeyHex
    );
    if (typeof result !== 'string') {
      throw new Error('Electron secure storage did not return encrypted data.');
    }

    return result;
  },
  decryptPrivateKey: async (encryptedPrivateKey: string) => {
    const result = await ipcRenderer.invoke(
      'desktop:secure-storage:decrypt-private-key',
      encryptedPrivateKey
    );
    return typeof result === 'string' ? result : null;
  },
  setUnreadChatBadge: (count: number, label: string) => {
    ipcRenderer.send('desktop:set-unread-chat-badge', { count, label });
  },
  showIncomingMessageNotification: (input: { chatPubkey: string; title: string; body: string }) => {
    ipcRenderer.send('desktop:show-incoming-message-notification', input);
  },
  onOpenChatFromNotification: (listener: (chatPubkey: string) => void) => {
    const wrappedListener = (_event: unknown, payload: unknown) => {
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof (payload as Record<string, unknown>).chatPubkey !== 'string'
      ) {
        return;
      }

      listener((payload as Record<string, string>).chatPubkey);
    };

    ipcRenderer.on('desktop:open-chat-from-notification', wrappedListener);
    return () => {
      ipcRenderer.removeListener('desktop:open-chat-from-notification', wrappedListener);
    };
  },
});
