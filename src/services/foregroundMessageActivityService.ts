import { inputSanitizerService } from 'src/services/inputSanitizerService';

export const FOREGROUND_MESSAGE_ACTIVITY_EVENT = 'anagram:foreground-message-activity';

export interface ForegroundMessageActivityDetail {
  chatPubkey: string;
  iconUrl: string;
  messageText: string;
  title: string;
  showBanner: boolean;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function emitForegroundMessageActivity(input: {
  chatPubkey: string;
  iconUrl?: string;
  messageText: string;
  title: string;
  showBanner: boolean;
}): void {
  if (
    typeof window === 'undefined' ||
    typeof window.dispatchEvent !== 'function' ||
    typeof CustomEvent !== 'function'
  ) {
    return;
  }

  const chatPubkey = inputSanitizerService.normalizeHexKey(input.chatPubkey);
  if (!chatPubkey) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<ForegroundMessageActivityDetail>(FOREGROUND_MESSAGE_ACTIVITY_EVENT, {
      detail: {
        chatPubkey,
        iconUrl: normalizeOptionalText(input.iconUrl),
        messageText: normalizeOptionalText(input.messageText),
        title: normalizeTitle(input.title),
        showBanner: Boolean(input.showBanner),
      },
    })
  );
}

export function readForegroundMessageActivityDetail(
  event: Event
): ForegroundMessageActivityDetail | null {
  if (
    typeof CustomEvent === 'undefined' ||
    !(event instanceof CustomEvent) ||
    event.type !== FOREGROUND_MESSAGE_ACTIVITY_EVENT
  ) {
    return null;
  }

  const value = event.detail;
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const chatPubkey = inputSanitizerService.normalizeHexKey(
    'chatPubkey' in value ? String(value.chatPubkey) : ''
  );
  if (!chatPubkey) {
    return null;
  }

  return {
    chatPubkey,
    iconUrl: normalizeOptionalText('iconUrl' in value ? value.iconUrl : ''),
    messageText: normalizeOptionalText('messageText' in value ? value.messageText : ''),
    title: normalizeTitle('title' in value ? String(value.title) : ''),
    showBanner: 'showBanner' in value ? Boolean(value.showBanner) : false,
  };
}
