const MAX_UNREAD_CHAT_BADGE_COUNT = 99;

export function formatUnreadChatBadgeLabel(count: number): string {
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return normalizedCount > MAX_UNREAD_CHAT_BADGE_COUNT
    ? `${MAX_UNREAD_CHAT_BADGE_COUNT}+`
    : String(normalizedCount);
}

export function formatUnreadDocumentTitle(title: string, count: number): string {
  const normalizedTitle = title.trim();
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (normalizedCount === 0) {
    return normalizedTitle;
  }

  return `(${formatUnreadChatBadgeLabel(normalizedCount)}) ${normalizedTitle}`.trim();
}
