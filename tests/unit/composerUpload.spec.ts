import { expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  createComposerUpload,
  appendUploadLink,
  draftAttachments,
} from '#src/lib/state/composerUpload.ts';
const upload = vi.hoisted(() => vi.fn());
vi.mock('#src/services/blossomUploadService.ts', () => ({ uploadBlossomMedia: upload }));
const attachment = { url: 'https://media.example/image.png', mimeType: 'image/png', size: 4 };
function setup() {
  let context = 'alice:chat';
  let complete!: (result: unknown) => void;
  upload.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const uploaded = vi.fn(),
    error = vi.fn();
  const uploader = createComposerUpload({
    context: () => context,
    serverUrl: () => 'https://media.example',
    signUploadAuthHeader: async () => '',
    uploaded,
    error,
  });
  uploader.choose(new File(['test'], 'image.png'));
  return {
    uploader,
    uploaded,
    error,
    complete: () => complete({ attachment }),
    context: (value: string) => {
      context = value;
    },
  };
}
it('delivers the uploaded link to the draft callback without sending a message', async () => {
  const f = setup();
  const pending = f.uploader.upload();
  expect(get(f.uploader.state).busy).toBe(true);
  f.complete();
  await pending;
  expect(f.uploaded).toHaveBeenCalledExactlyOnceWith(attachment);
  expect(get(f.uploader.state)).toEqual({ busy: false });
  expect(appendUploadLink('A caption', attachment.url)).toBe(`A caption\n${attachment.url}`);
  expect(draftAttachments('A caption', [attachment])).toEqual([]);
  expect(draftAttachments(`A caption\n${attachment.url}`, [attachment])).toEqual([attachment]);
});
it.each(['cancel', 'chat', 'account'])(
  'ignores a late upload result after %s changes',
  async (reason) => {
    const f = setup();
    const pending = f.uploader.upload();
    const signal = upload.mock.calls.at(-1)![1].signal;
    if (reason === 'cancel') f.uploader.cancel();
    else {
      f.context(reason === 'chat' ? 'alice:other' : 'bob:chat');
      f.uploader.checkContext();
    }
    expect(signal.aborted).toBe(true);
    f.complete();
    await pending;
    expect(f.uploaded).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
    expect(get(f.uploader.state)).toEqual({ busy: false });
  },
);
