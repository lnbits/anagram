# Development and hosting

## Web hosting

```sh
npm ci
npm run build
```

Serve `build/` at the root of an HTTPS origin, with unknown routes falling back to `index.html`. No Node application server is needed.

- Serve `.js` as JavaScript and `.wasm` as `application/wasm`.
- Use `Cache-Control: no-cache` for `index.html`, `service-worker.js`, `manifest.webmanifest`, and `build-info.json`.
- Cache `/_app/immutable/` files immutably; retain the previous deployment’s hashed assets during rollout.
- Set `X-Content-Type-Options: nosniff` and `Content-Security-Policy: frame-ancestors 'none'` headers.

The PWA caches the app shell; saved messages remain in IndexedDB. Relay sync and calls require connectivity. Updates activate after open app windows close. **Settings → Force refresh** reloads without deleting messages. For an old broken worker, hard-refresh once, close all app tabs, then reopen; don’t clear IndexedDB.

PWA installation is available in production builds. On iPhone, use Safari → Share → Add to Home Screen. There is no push delivery while the app is closed.

## Social link previews

The client URL includes a branded Open Graph / Twitter card. Copied public-chat and Iroh-call links use `/join/chat.html#/public/<naddr>` and `/join/call.html#/call/<token>`. The static entry pages expose “Join chat” and “Join call” cards without JavaScript, then open the existing app flow in browsers. Call secrets remain in the fragment, outside HTTP requests and preview metadata. Existing direct links still open normally.

Serve the actual `build/join/*.html` files before the SPA fallback, and serve `build/social/*.jpg` as `image/jpeg`. Include these files when deploying; no preview backend is needed. If hosting on another domain, change the absolute `https://anagram.chat` metadata URLs in `src/app.html` and `static/join/*.html`. Social platforms may cache previously fetched previews.

The three committed 1200×630 cards reuse the app logo and font. Regenerate them with `npm run assets:social` (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when using a system Chromium). The layout lives in `scripts/render-social-cards.mjs`. Verify the built HTML, images and offline entry pages with `npm run test:e2e:pwa -- e2e/pwa/social-previews.spec.ts`.

## Native development

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On NixOS:

```sh
nix-shell shell.nix --run 'npm run dev:desktop'
nix-shell shell.nix --run 'cargo check --manifest-path src-tauri/Cargo.toml'
```

Android requires Java 17, Android SDK/NDK, and Rust Android targets:

```sh
npm run tauri -- android init --ci
node scripts/prepare-android.mjs
node scripts/mobile-version.mjs
npm run tauri -- icon src-tauri/icons/icon.png --output src-tauri/icons
npm run tauri -- android build --ci --apk --target aarch64 armv7 --config src-tauri/mobile-version.json -- --locked
```

With Android notifications enabled and a local signing key, the relay listener can show incoming direct calls while the UI is closed. Answer opens the app and answers with audio; Decline sends an encrypted response in the background. Caller identity follows “Show who messaged” and is hidden by default. The listener must remain running and connected; force-stopping the app prevents delivery.

APKs appear under `src-tauri/gen/android/app/build/outputs/apk/`. The preparation script configures permissions, Android Keystore storage, and compatible build tooling.

For an unsigned iPhone build on macOS with Xcode:

```sh
npm run tauri -- ios init --ci
node scripts/mobile-version.mjs
npm run tauri -- ios build --ci --target aarch64 --no-sign --config src-tauri/mobile-version.json -- --locked
```

IPAs appear under `src-tauri/gen/apple/build/`. See [signing setup](releases.md) for installable builds.

## Extra checks

```sh
npm run build
npm run test:e2e:pwa
npm run verify:iroh
```

Browser tests use generated accounts and local relays. On NixOS, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome`.

Live call tests require an Iroh relay on `127.0.0.1:7003` and `openssl` on PATH. They use synthetic media, not your camera or microphone:

```sh
ANAGRAM_LIVE_CALL_TEST=1 npm run test:e2e:local -- e2e/parity/calls.spec.ts e2e/calls.spec.ts
ANAGRAM_PERF_TEST=1 npm run test:e2e:local -- e2e/dm-performance.spec.ts
```

The performance test measures local ingestion, excluding relay latency. [Parity coverage](../e2e/parity/coverage.json) maps the original behavioral tests to the rebuild.

## Source and generated files

Commit source, tests, configuration, workflows, assets, and npm/Cargo lockfiles. Dependencies, Rust `target/`, web builds, native `gen/` projects, reports, and signing credentials are ignored.

Keep the generated `static/iroh/` bindings and hash manifest committed alongside their Rust source so web development only needs Node. Update both when changing the transport.

Protocol code lives in `src/stores/nostr/`; the nostr-tools adapter is `src/lib/nostr/client.ts`. Hydration must retain account isolation, UI-before-message-storage updates, bounded database reads, and history coverage based on real relay EOSE.

The Linux AppImage builds a pinned GStreamer runtime on Ubuntu 22.04 (`scripts/appimage/build-gstreamer.sh`). WebKitGTK requires GStreamer 1.24.9 or newer for WebM recording, plus the Opus parser, transcoder and automatic video conversion plugins. Release checks record synthetic audio/video and decode the chunks through MediaSource inside the packaged WebView; file playback alone does not verify call support.
