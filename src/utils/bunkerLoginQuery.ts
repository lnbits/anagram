import type { LocationQuery, LocationQueryRaw } from '#src/lib/platform/router.ts';

export const BUNKER_LOGIN_QUERY_PARAM = 'bunker';
export const ALREADY_LOGGED_IN_BUNKER_MESSAGE = 'A user is already logged in.';

function firstQueryStringValue(
  value: LocationQuery[string] | LocationQueryRaw[string]
): string | null {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = firstQueryStringValue(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readBunkerLoginQueryParam(query: LocationQuery | LocationQueryRaw): string | null {
  return firstQueryStringValue(query[BUNKER_LOGIN_QUERY_PARAM]);
}

export function withoutBunkerLoginQueryParam(
  query: LocationQuery | LocationQueryRaw
): LocationQueryRaw {
  const nextQuery: LocationQueryRaw = {};

  for (const [key, value] of Object.entries(query)) {
    if (key !== BUNKER_LOGIN_QUERY_PARAM) {
      nextQuery[key] = value;
    }
  }

  return nextQuery;
}

export function removeBunkerLoginQueryParamFromUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(BUNKER_LOGIN_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readTopLevelBunkerLoginQueryParam(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return firstQueryStringValue(
    new URLSearchParams(window.location.search).get(BUNKER_LOGIN_QUERY_PARAM)
  );
}

export function removeTopLevelBunkerLoginQueryParam(): void {
  if (typeof window === 'undefined' || typeof window.history === 'undefined') {
    return;
  }

  const searchParams = new URLSearchParams(window.location.search);
  if (!searchParams.has(BUNKER_LOGIN_QUERY_PARAM)) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    '',
    removeBunkerLoginQueryParamFromUrl(window.location.href)
  );
}
