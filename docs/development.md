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

## GitHub Pages

The `Checks` workflow deploys `build/` to the repository's `github-pages` environment after all web checks pass on a push to `main`. Pull requests and other branches only run checks. To redeploy manually, run `Checks` from the Actions tab with `main` selected; the same checks must pass first.

Keep Settings → Pages → Source set to **GitHub Actions** and the custom domain set to `chat.nostr.com`. The domain is managed in Pages settings. The workflow uploads the tested build and copies its app shell to `404.html` so direct chat and call routes can open on Pages. GitHub Pages still returns HTTP 404 for those fallback routes; the client renders the requested screen. Active deployments are allowed to finish before the next main run.

## Social link previews

All links use the static card in `static/social/anagram-v2.jpg`. Public-chat and call share links use `/join/chat.html#/public/<naddr>` and `/join/call.html#/call/<token>`. Their entry pages expose preview metadata without JavaScript and redirect browsers into the app. Call secrets stay in the fragment, outside HTTP requests.

Serve `build/join/*.html` before the SPA fallback and `build/social/*.jpg` as `image/jpeg`. For another domain, update the absolute metadata URLs in `src/app.html` and `static/join/*.html`.

Regenerate the image with `npm run assets:social`; edit its layout in `scripts/render-social-cards.mjs`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for system Chromium. Check the static pages with `npm run test:e2e:pwa -- e2e/pwa/social-previews.spec.ts`.

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
node scripts/prepare-ios.mjs
node scripts/mobile-version.mjs
npm run tauri -- ios build --ci --target aarch64 --no-sign --config src-tauri/mobile-version.json -- --locked
```

IPAs appear under `src-tauri/gen/apple/build/`. The preparation script adds the required-reason API privacy manifest and generates opaque App Store icons. Run it again after regenerating the Xcode project. See [signing setup](releases.md) for installable builds.

For an installed simulator launch check, run `node scripts/build-ios-simulator.mjs`, then `python3 scripts/release-smoke/ios.py`. The helper selects the host architecture and explicitly targets the iOS Simulator during archiving. Move any device archive out of `src-tauri/gen/apple/build/` first: the smoke check expects exactly one Anagram application there. Use a simulator with English as its system language and no saved Anagram account. The check requires visible welcome/login controls using macOS Vision text recognition and captures a launch screenshot; it does not validate real-device audio, permissions, or calls.

The iOS app stores messages in IndexedDB and the signing key in Apple Keychain.

The WebM Opus/VP8 recorder used by the call protocol requires iOS/iPadOS 18.4 or newer; capability checks still determine whether audio/video is available. See [WebKit's recording support](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) and [managed playback requirements](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/). Older systems can still use chat.

The iPhone workflow runs WebKit playback tests and simulated native viewport tests before packaging. Run the same checks on macOS with `npx playwright install webkit` followed by `npm run test:e2e:local -- --browser webkit e2e/ios-layout.spec.ts e2e/call-playback.spec.ts`. The viewport tests mock the OS Keychain and keyboard boundaries; they do not validate the installed app. On a signed iPhone build, verify saved login after restart/logout, camera/microphone grant and denial, keyboard/rotation, headset routing, and calls between iPhone and Android.

The iOS app supports messaging and calls while open. Background notifications, lock-screen answering and closed-app incoming calls are unsupported; background call continuity requires device validation. No APNs or PushKit/CallKit integration is included.

Speaking indicators meter call audio in one shared, output-less `AudioContext`. Remote audio on the WebM/MediaSource path (native Linux, and peers without packet audio) is metered through `HTMLMediaElement.captureStream()`, which WebKit does not provide, so those calls show no speaking indicator on iOS, macOS or Linux. Firefox only offers `mozCaptureStream()`, which can divert the element's playback away from the speakers, so that path is not metered in Firefox either. In Max fill, a direct call without remote video shows its media alone, without the peer's avatar or speaking ring. While a call is on screen this context runs alongside the packet-audio engine; its effect on receiver/loudspeaker and headset routing has not been validated on physical iOS or Android devices.

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
