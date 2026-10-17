import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
import { isEncryptedAttachment } from '#src/utils/messageAttachments.ts';

export type EncryptedMediaLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface EncryptedMediaLoadState {
  status: EncryptedMediaLoadStatus;
  objectUrl: string;
}

interface ObjectUrlSource {
  acquireDecryptedObjectUrl: (attachment: MessageAttachmentMetadata) => Promise<string>;
  releaseDecryptedObjectUrl: (attachment: MessageAttachmentMetadata) => void;
}

// Explicit-action loader for encrypted video and audio. Nothing is downloaded or decrypted
// until load() is called, and dispose() releases the reference-counted object URL, including
// when it is called while a load is still in flight.
export function createEncryptedMediaLoader(
  source: ObjectUrlSource,
  onChange: (state: EncryptedMediaLoadState) => void
) {
  let generation = 0;
  let acquired: MessageAttachmentMetadata | null = null;
  let state: EncryptedMediaLoadState = { status: 'idle', objectUrl: '' };

  function setState(next: EncryptedMediaLoadState): void {
    state = next;
    onChange(next);
  }

  function release(): void {
    if (acquired) {
      source.releaseDecryptedObjectUrl(acquired);
      acquired = null;
    }
  }

  async function load(attachment: MessageAttachmentMetadata): Promise<void> {
    if (state.status === 'loading' || state.status === 'ready') {
      return;
    }
    if (!isEncryptedAttachment(attachment)) {
      setState({ status: 'failed', objectUrl: '' });
      return;
    }

    generation += 1;
    const current = generation;
    const snapshot: MessageAttachmentMetadata = {
      ...attachment,
      encryption: { ...attachment.encryption },
    };
    acquired = snapshot;
    setState({ status: 'loading', objectUrl: '' });
    try {
      const objectUrl = await source.acquireDecryptedObjectUrl(snapshot);
      if (current === generation) {
        setState({ status: 'ready', objectUrl });
      }
    } catch {
      // A failed load is not cached by the service, so there is no reference to release.
      if (acquired === snapshot) {
        acquired = null;
      }
      if (current === generation) {
        setState({ status: 'failed', objectUrl: '' });
      }
    }
  }

  function dispose(): void {
    generation += 1;
    release();
    state = { status: 'idle', objectUrl: '' };
  }

  return { load, dispose };
}
