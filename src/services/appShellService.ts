export interface AppBuildInfo {
  appVersion: string;
  bundleId: string;
}

export type ForceRefreshResult =
  | { ok: true }
  | { ok: false; reason: 'server-unreachable' | 'browser-unsupported' | 'refresh-in-progress' };

export const APP_SHELL_CACHE_PREFIX = 'nostr-chat-app-shell-';
export const CURRENT_APP_BUILD_INFO: AppBuildInfo = {
  appVersion: readStringEnv(process.env.APP_VERSION, '0.0.0'),
  bundleId: readStringEnv(process.env.APP_BUNDLE_ID, 'dev'),
};

const BUILD_INFO_FILENAME = 'build-info.json';
const SERVICE_WORKER_FILENAME = 'service-worker.js';
const REACHABILITY_CHECK_FILENAME = 'index.html';
const DEFAULT_FETCH_TIMEOUT_MS = 6000;

interface FetchOptions {
  currentHref?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function readStringEnv(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readBooleanEnv(value: unknown): boolean {
  return value === true || value === 'true';
}

function canUseWindow(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

function resolveFetchImpl(fetchImpl?: typeof fetch): typeof fetch | null {
  if (fetchImpl) {
    return fetchImpl;
  }

  return typeof fetch === 'function' ? fetch.bind(globalThis) : null;
}

export function isAppShellRuntimeEnabled(): boolean {
  if (!readBooleanEnv(process.env.APP_ENABLE_APP_SHELL) || !canUseWindow()) {
    return false;
  }

  return isHttpProtocol(window.location.protocol);
}

export function canRegisterAppShellServiceWorker(): boolean {
  return (
    isAppShellRuntimeEnabled() && 'serviceWorker' in navigator && window.isSecureContext === true
  );
}

export function canUseAppShellCaches(): boolean {
  return typeof caches !== 'undefined';
}

export function normalizeAppBuildInfo(value: unknown): AppBuildInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<AppBuildInfo>;
  if (
    typeof candidate.appVersion !== 'string' ||
    candidate.appVersion.trim().length === 0 ||
    typeof candidate.bundleId !== 'string' ||
    candidate.bundleId.trim().length === 0
  ) {
    return null;
  }

  return {
    appVersion: candidate.appVersion.trim(),
    bundleId: candidate.bundleId.trim(),
  };
}

export function hasDifferentBundle(
  currentBuildInfo: AppBuildInfo,
  serverBuildInfo: AppBuildInfo | null
): boolean {
  return Boolean(serverBuildInfo && serverBuildInfo.bundleId !== currentBuildInfo.bundleId);
}

export function resolveAppShellUrl(pathname: string, currentHref: string): string {
  const baseUrl = new URL(currentHref);
  baseUrl.hash = '';
  baseUrl.search = '';

  if (!baseUrl.pathname.endsWith('/')) {
    baseUrl.pathname = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf('/') + 1);
  }

  return new URL(pathname, baseUrl).toString();
}

function buildRuntimeUrl(pathname: string, currentHref?: string): URL {
  if (currentHref) {
    return new URL(resolveAppShellUrl(pathname, currentHref));
  }

  return new URL(resolveAppShellUrl(pathname, window.location.href));
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export async function fetchServerBuildInfo(
  options: FetchOptions = {}
): Promise<AppBuildInfo | null> {
  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  if (!fetchImpl) {
    return null;
  }

  const url = buildRuntimeUrl(BUILD_INFO_FILENAME, options.currentHref);
  url.searchParams.set('_', String(Date.now()));

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    );
    if (!response.ok) {
      return null;
    }

    return normalizeAppBuildInfo(await response.json());
  } catch {
    return null;
  }
}

export async function canReachAppServer(options: FetchOptions = {}): Promise<boolean> {
  const fetchImpl = resolveFetchImpl(options.fetchImpl);
  if (!fetchImpl) {
    return false;
  }

  const url = buildRuntimeUrl(REACHABILITY_CHECK_FILENAME, options.currentHref);
  url.searchParams.set('__nc_force_refresh_check', String(Date.now()));

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function registerAppShellServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterAppShellServiceWorker()) {
    return null;
  }

  const serviceWorkerUrl = buildRuntimeUrl(SERVICE_WORKER_FILENAME);
  const registration = await navigator.serviceWorker.register(serviceWorkerUrl.toString());
  void registration.update().catch((error) => {
    console.warn('Failed to check for an app shell service worker update.', error);
  });
  return registration;
}

export async function clearAppShellCaches(): Promise<void> {
  if (!canUseAppShellCaches()) {
    return;
  }

  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith(APP_SHELL_CACHE_PREFIX))
      .map((name) => caches.delete(name))
  );
}

export async function unregisterAppShellServiceWorkers(): Promise<void> {
  if (!canRegisterAppShellServiceWorker()) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  const appBaseUrl = buildRuntimeUrl('');
  await Promise.all(
    registrations
      .filter((registration) => registration.scope === appBaseUrl.toString())
      .map((registration) => registration.unregister())
  );
}
