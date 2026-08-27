import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure } from 'quasar/wrappers';
import type { Plugin } from 'vite';
import {
  DESKTOP_VIEWPORT_MEDIA_TOKEN,
  MOBILE_BREAKPOINT_PX,
  MOBILE_VIEWPORT_MEDIA_TOKEN,
} from './src/config/responsiveBreakpoints';

interface PackageJson {
  name?: string;
  productName?: string;
  version?: string;
  description?: string;
}

interface AppBuildInfo {
  appVersion: string;
  bundleId: string;
  builtAt: string;
}

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
) as PackageJson;
const appVersion = packageJson.version ?? '0.0.0';
const MOBILE_VIEWPORT_MAX_WIDTH_PX = MOBILE_BREAKPOINT_PX - 0.02;

function createResponsiveMediaQueryPlugin(): Plugin {
  const replacements = [
    [MOBILE_VIEWPORT_MEDIA_TOKEN, `(max-width: ${MOBILE_VIEWPORT_MAX_WIDTH_PX}px)`],
    [DESKTOP_VIEWPORT_MEDIA_TOKEN, `(min-width: ${MOBILE_BREAKPOINT_PX}px)`],
  ] as const;

  return {
    name: 'nostr-chat-responsive-media-queries',
    enforce: 'pre',
    transform(source, id) {
      const sourcePath = id.split('?', 1)[0] ?? '';
      if (!sourcePath.endsWith('.css') && !sourcePath.endsWith('.vue')) {
        return null;
      }

      const transformedSource = replacements.reduce(
        (result, [token, query]) => result.replaceAll(token, query),
        source
      );

      return transformedSource === source ? null : { code: transformedSource, map: null };
    },
  };
}

function readGitSha(): string {
  try {
    return execSync('git rev-parse --short=12 HEAD', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function formatBundleTimestamp(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildAppInfo(isProd: boolean): AppBuildInfo {
  const builtAt = process.env.APP_BUILD_TIME?.trim() || new Date().toISOString();
  const gitSha = process.env.APP_GIT_SHA?.trim() || readGitSha();
  const envBundleId = process.env.APP_BUNDLE_ID?.trim();

  return {
    appVersion,
    bundleId:
      envBundleId || (isProd ? `${gitSha}-${formatBundleTimestamp(builtAt)}` : `dev-${gitSha}`),
    builtAt,
  };
}

function createAppShellBuildPlugin(buildInfo: AppBuildInfo): Plugin {
  return {
    name: 'nostr-chat-app-shell-build',
    apply: 'build',
    writeBundle(outputOptions) {
      if (!outputOptions.dir) {
        return;
      }

      writeFileSync(
        path.join(outputOptions.dir, 'build-info.json'),
        `${JSON.stringify(buildInfo, null, 2)}\n`,
        'utf-8'
      );
      writeFileSync(
        path.join(outputOptions.dir, 'service-worker.js'),
        buildServiceWorkerSource(buildInfo, listPrecachePaths(outputOptions.dir)),
        'utf-8'
      );
    },
  };
}

function listPrecachePaths(distDir: string): string[] {
  const precachePaths = new Set<string>(['', 'index.html']);
  const excludedFiles = new Set(['build-info.json', 'service-worker.js']);

  function walk(relativeDir: string): void {
    const absoluteDir = path.join(distDir, relativeDir);
    if (!existsSync(absoluteDir)) {
      return;
    }

    for (const entry of readdirSync(absoluteDir)) {
      const relativePath = path.join(relativeDir, entry);
      const normalizedPath = relativePath.split(path.sep).join('/');
      const absolutePath = path.join(distDir, relativePath);
      const stats = statSync(absolutePath);

      if (stats.isDirectory()) {
        walk(relativePath);
        continue;
      }

      if (
        excludedFiles.has(normalizedPath) ||
        normalizedPath.endsWith('.map') ||
        normalizedPath.endsWith('.br') ||
        normalizedPath.endsWith('.gz')
      ) {
        continue;
      }

      precachePaths.add(normalizedPath);
    }
  }

  walk('');

  return [...precachePaths].sort((left, right) => {
    if (left === '') {
      return -1;
    }
    if (right === '') {
      return 1;
    }
    if (left === 'index.html') {
      return -1;
    }
    if (right === 'index.html') {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function buildServiceWorkerSource(buildInfo: AppBuildInfo, precachePaths: string[]): string {
  return `const APP_SHELL_CACHE_PREFIX = 'nostr-chat-app-shell-';
const CACHE_NAME = \`\${APP_SHELL_CACHE_PREFIX}${buildInfo.bundleId}\`;
const PRECACHE_PATHS = ${JSON.stringify(precachePaths, null, 2)};

function scopeUrl(path) {
  return new URL(path, self.registration.scope).toString();
}

function isBuildInfoRequest(url) {
  return url.pathname.endsWith('/build-info.json');
}

function shouldBypassCache(request, url) {
  return request.cache === 'no-store' || isBuildInfoRequest(url);
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html');
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(PRECACHE_PATHS.map(scopeUrl));
}

async function deleteOldAppShellCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith(APP_SHELL_CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name))
  );
}

async function cacheResponse(request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque') {
    return;
  }

  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch {
    // Ignore cache write failures so a valid network response can still be used.
  }
}

async function fetchNavigation(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    await cacheResponse(scopeUrl('index.html'), response);
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match(scopeUrl('index.html'))) ||
      (await cache.match(scopeUrl(''))) ||
      Response.error()
    );
  }
}

async function fetchAsset(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  await cacheResponse(request, response);
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    deleteOldAppShellCaches().then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);
  const scope = self.registration.scope;
  if (requestUrl.origin !== self.location.origin || !requestUrl.href.startsWith(scope)) {
    return;
  }

  if (shouldBypassCache(request, requestUrl)) {
    event.respondWith(fetch(request));
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(fetchNavigation(request));
    return;
  }

  event.respondWith(fetchAsset(request));
});
`;
}

export default configure((ctx) => {
  const buildInfo = buildAppInfo(ctx.prod);
  const enableAppShell = ctx.modeName === 'spa' && ctx.prod;

  return {
    boot: ['screen', 'i18n'],

    css: ['app.css'],
    extras: ['material-icons'],

    build: {
      target: {
        browser: ['es2022', 'firefox115', 'chrome115', 'safari14'],
        node: 'node24',
      },
      vueRouterMode: 'hash',
      env: {
        APP_VERSION: buildInfo.appVersion,
        APP_BUNDLE_ID: buildInfo.bundleId,
        APP_BUILD_TIME: buildInfo.builtAt,
        APP_ENABLE_APP_SHELL: enableAppShell,
        APP_E2E_DISABLE_NDK_OUTBOX: process.env.APP_E2E_DISABLE_NDK_OUTBOX === 'true',
      },
      vitePlugins: [
        createResponsiveMediaQueryPlugin(),
        ...(enableAppShell ? [createAppShellBuildPlugin(buildInfo)] : []),
      ],
    },

    devServer: {
      open: false,
      allowedHosts: ['.ngrok-free.app', '.ngrok.app'],
    },

    framework: {
      config: {
        dark: true,
      },
      plugins: ['Dark', 'Notify', 'Dialog'],
    },

    electron: {
      bundler: 'builder',
      builder: {
        appId: 'com.lnbits.nostrchat',
        productName: 'Nostr Chat',
        artifactName: `\${productName}-\${version}-\${os}-\${arch}.\${ext}`,
        mac: {
          category: 'public.app-category.social-networking',
          target: ['zip'],
        },
        win: {
          target: ['nsis'],
        },
        linux: {
          category: 'Network',
          icon: 'icons/icon.png',
          maintainer: 'LNbits',
          target: ['AppImage', 'deb', 'rpm'],
        },
      },
    },

    animations: [],
  };
});
