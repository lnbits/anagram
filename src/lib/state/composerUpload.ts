import { get, writable } from 'svelte/store';
import { uploadBlossomMedia } from '#src/services/blossomUploadService.ts';
import type { MessageAttachmentMetadata } from '#src/types/chat.ts';

// Shared by private and public composers. Closing or changing context cancels
// delivery of the result even if the server finishes storing the uploaded blob.
export function createComposerUpload(deps: {
  context: () => string;
  serverUrl: () => string;
  signUploadAuthHeader: (input: { serverUrl: string; sha256: string }) => Promise<string>;
  uploaded: (attachment: MessageAttachmentMetadata) => void;
  error: (error: unknown) => void;
}) {
  const state = writable<{ file?: File; busy: boolean }>({ busy: false });
  let controller: AbortController | undefined;
  let context = '';
  function cancel() {
    controller?.abort();
    controller = undefined;
    context = '';
    state.set({ busy: false });
  }
  function choose(file: File) {
    cancel();
    context = deps.context();
    state.set({ file, busy: false });
  }
  function checkContext() {
    if (context && context !== deps.context()) cancel();
  }
  async function upload() {
    checkContext();
    const { file, busy } = get(state);
    if (!file || busy || !context) return;
    const current = new AbortController();
    controller = current;
    state.set({ file, busy: true });
    try {
      const result = await uploadBlossomMedia(file, {
        serverUrl: deps.serverUrl(),
        signUploadAuthHeader: deps.signUploadAuthHeader,
        signal: current.signal,
      });
      if (controller !== current || current.signal.aborted || context !== deps.context()) return;
      deps.uploaded(result.attachment);
      state.set({ busy: false });
    } catch (error) {
      if (controller === current && !current.signal.aborted && context === deps.context()) {
        state.set({ file, busy: false });
        deps.error(error);
      }
    } finally {
      if (controller === current) controller = undefined;
    }
  }
  return { state, choose, upload, cancel, checkContext };
}
export function appendUploadLink(draft: string, url: string): string {
  return draft ? `${draft}${/\s$/.test(draft) ? '' : '\n'}${url}` : url;
}
export function draftAttachments(text: string, attachments: MessageAttachmentMetadata[] = []) {
  const tokens = new Set(text.split(/\s+/));
  return attachments.filter((attachment) => tokens.has(attachment.url));
}
