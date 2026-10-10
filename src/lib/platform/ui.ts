import { diagnosticText } from '#src/utils/diagnosticExport.ts';
import { writable } from 'svelte/store';
export const notices = writable<{ id: number; message: string; type?: string }[]>([]);
export const Notify = {
  create(options: string | { message: string; type?: string; [key: string]: unknown }) {
    const item = {
      id: Date.now() + Math.random(),
      ...(typeof options === 'string' ? { message: options } : options),
    };
    item.message = diagnosticText(item.message);
    notices.update((items) => [...items, item]);
    setTimeout(() => notices.update((items) => items.filter((x) => x.id !== item.id)), 6000);
    return () => notices.update((items) => items.filter((x) => x.id !== item.id));
  },
};
export type QVueGlobals = { notify: typeof Notify.create; dialog: typeof Dialog.create };
export interface CallRelayPrompt {
  id: number;
  title: string;
  message: string;
  allowLabel: string;
  cancelLabel: string;
  finish: (allow: boolean) => void;
}
export const callRelayPrompts = writable<CallRelayPrompt[]>([]);
let promptSequence = 0;
export const Dialog = {
  create(options: { title?: string; message?: string; [key: string]: unknown }) {
    let ok: (value?: unknown) => void = () => {};
    let dismiss: () => void = () => {};
    let cancel: () => void = () => {};
    let hidden = false;
    const promptId = ++promptSequence;
    const finish = (allow: boolean) => {
      if (hidden) return;
      hidden = true;
      callRelayPrompts.update((items) => items.filter((item) => item.id !== promptId));
      if (allow) ok();
      else cancel();
      dismiss();
    };
    const result = {
      onOk(fn: (value?: unknown) => void) {
        ok = fn;
        return result;
      },
      onCancel(fn: () => void) {
        cancel = fn;
        return result;
      },
      onDismiss(fn: () => void) {
        dismiss = fn;
        return result;
      },
      hide() {
        finish(false);
      },
    };
    if (options.callRelay === true) {
      callRelayPrompts.update((items) => [
        ...items,
        {
          id: promptId,
          title: options.title ?? '',
          message: options.message ?? '',
          allowLabel: (options.ok as { label?: string } | undefined)?.label ?? 'Allow once',
          cancelLabel: (options.cancel as { label?: string } | undefined)?.label ?? 'Decline',
          finish,
        },
      ]);
      return result;
    }
    setTimeout(() => {
      if (!hidden && window.confirm(`${options.title ?? ''}\n\n${options.message ?? ''}`)) ok();
      else if (!hidden) cancel();
      dismiss();
    });
    return result;
  },
};
