import { afterEach, expect, it, vi } from 'vitest';
import { watchCallAudioContext } from '#src/services/callAudioRecovery.ts';

afterEach(() => vi.unstubAllGlobals());
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  const context = Object.assign(new EventTarget(), {
    state: 'running',
    resume: vi.fn(async () => {}),
  });
  const recovery = watchCallAudioContext(context as unknown as AudioContext);
  return { document, window, context, recovery };
}

it('resumes after interruption, visibility regain and capture unmute, and detaches on hangup', async () => {
  const { document, window, context, recovery } = setup();
  context.dispatchEvent(new Event('statechange'));
  expect(context.resume).not.toHaveBeenCalled();
  context.state = 'interrupted';
  context.dispatchEvent(new Event('statechange'));
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(1));
  await settle();
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(context.resume).toHaveBeenCalledTimes(1);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));
  await settle();
  recovery.resume();
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(3));
  recovery.close();
  context.dispatchEvent(new Event('statechange'));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pageshow'));
  document.dispatchEvent(new Event('pointerdown'));
  document.dispatchEvent(new Event('visibilitychange'));
  recovery.resume();
  expect(context.resume).toHaveBeenCalledTimes(3);
});

it('bounds pending resumes but permits a new user gesture to satisfy autoplay policy', async () => {
  const { context, window, document, recovery } = setup();
  let finish!: () => void;
  context.resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  context.state = 'suspended';
  context.dispatchEvent(new Event('statechange'));
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(context.resume).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event('pointerdown'));
  expect(context.resume).toHaveBeenCalledTimes(2);
  recovery.close();
  finish();
});

it('does not spin after a rejected resume and retries on a later lifecycle event', async () => {
  const { context, window, recovery } = setup();
  context.resume.mockRejectedValueOnce(new Error('Interrupted'));
  context.state = 'suspended';
  context.dispatchEvent(new Event('statechange'));
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledOnce());
  await settle();
  window.dispatchEvent(new Event('pageshow'));
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));
  context.state = 'closed';
  window.dispatchEvent(new Event('focus'));
  expect(context.resume).toHaveBeenCalledTimes(2);
  recovery.close();
});
