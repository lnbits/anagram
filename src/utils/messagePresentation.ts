import type { Message } from '#src/types/chat.ts';
import { chatDate } from './chatDate.ts';

export function messagePresentation(
  message: Message,
  previous: Message | undefined,
  next: Message | undefined,
  locale: string,
) {
  const dayLabel = chatDate(message.sentAt, locale);
  const sameDay = (other: Message | undefined) =>
    Boolean(other && chatDate(other.sentAt, locale) === dayLabel);
  const sameSender = (other: Message | undefined) =>
    Boolean(other && other.authorPublicKey === message.authorPublicKey && sameDay(other));
  return {
    dayLabel,
    startsDay: !sameDay(previous),
    continuesSender: sameSender(previous),
    senderContinues: sameSender(next),
  };
}

export function messageMenuPosition(event: MouseEvent) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.clientX || event.clientY
    ? { x: event.clientX, y: event.clientY }
    : { x: bounds.left, y: bounds.bottom };
}
