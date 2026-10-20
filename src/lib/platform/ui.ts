import { diagnosticText } from '#src/utils/diagnosticExport.ts';
import { writable } from 'svelte/store';
type ActionFeedback = { message: string; type?: string; [key: string]: unknown };
export const actionFeedback = writable<ActionFeedback | null>(null);
export function reportActionFeedback(options: string | ActionFeedback) {
  const item = typeof options === 'string' ? { message: options } : options;
  actionFeedback.set({ ...item, message: diagnosticText(item.message) });
}
export const incomingMessageBanner = writable('');
export function showIncomingMessageBanner(message: string) {
  incomingMessageBanner.set(diagnosticText(message));
  const timer = setTimeout(() => incomingMessageBanner.set(''), 6000);
  return () => {
    clearTimeout(timer);
    incomingMessageBanner.set('');
  };
}
export type QVueGlobals = { notify: typeof reportActionFeedback; dialog: typeof Dialog.create };
export interface CallRelayPrompt {
  id: number;
  title: string;
  message: string;
  allowLabel: string;
  cancelLabel: string;
  finish: (allow: boolean) => void;
}
export const callRelayPrompts = writable<CallRelayPrompt[]>([]);
interface DialogOptions {
  title?: string;
  message?: string;
  ok?: { label?: string; [key: string]: unknown };
  cancel?: { label?: string; [key: string]: unknown };
  persistent?: boolean;
  callRelay?: boolean;
  options?: {
    type: 'checkbox';
    model: string[];
    items: { label: string; value: string; [key: string]: unknown }[];
  };
  [key: string]: unknown;
}
export interface AppPrompt {
  id: number;
  title: string;
  message: string;
  allowLabel: string;
  cancelLabel: string;
  persistent: boolean;
  choices: { label: string; value: string }[];
  selected: string[];
  finish: (allow: boolean, selected?: string[]) => void;
}
export const appPrompts = writable<AppPrompt[]>([]);
let promptSequence = 0;
export const Dialog = {
  create(options: DialogOptions) {
    let ok: (value?: unknown) => void = () => {};
    let dismiss: () => void = () => {};
    let cancel: () => void = () => {};
    let hidden = false;
    const promptId = ++promptSequence;
    const finish = (allow: boolean, selected?: string[]) => {
      if (hidden) return;
      hidden = true;
      callRelayPrompts.update((items) => items.filter((item) => item.id !== promptId));
      appPrompts.update((items) => items.filter((item) => item.id !== promptId));
      if (allow) ok(selected);
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
    appPrompts.update((items) => [
      ...items,
      {
        id: promptId,
        title: options.title ?? '',
        message: options.message ?? '',
        allowLabel: options.ok?.label ?? 'OK',
        cancelLabel: options.cancel?.label ?? 'Cancel',
        persistent: options.persistent === true,
        choices: options.options?.items ?? [],
        selected: [...(options.options?.model ?? [])],
        finish,
      },
    ]);
    return result;
  },
};
