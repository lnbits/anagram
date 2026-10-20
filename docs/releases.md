# Releases

Before creating a release tag, update and check the app version:

```sh
npm run release:version -- v0.9.1
npm run release:check -- v0.9.1
```

Commit the changes to `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`, then tag that commit and push the tag to run [release.yml](../.github/workflows/release.yml). CI checks every committed app version against the tag before changing any version files and fails on a mismatch. Branch and pull-request CI also checks that these files agree with `package.json`.

`release:version` updates all five files, including both root version fields in `package-lock.json`. If `src-tauri/mobile-version.json` exists locally, it also updates its numeric marketing version while preserving the mobile build numbers. Generated native projects and web bundles get their versions during generation/build; rebuild them after a version bump instead of editing the generated outputs. `release:check` is read-only; with no version argument, it checks against `package.json`.

| Tag                           | Result                             |
| ----------------------------- | ---------------------------------- |
| `v0.9.1`                      | Published release                  |
| `v0.9.1-beta.1`               | Published prerelease               |
| `v0.9.1-rc1` or `v0.9.1-rc.1` | Draft prerelease, including reruns |

The release waits for all builds and checks, then attaches Windows `.exe`, Intel/Apple Silicon `.dmg`, Linux `.AppImage`, Android `.apk`, `anagram-web.zip`, and `SHA256SUMS.txt`. With `IOS_BUILDS_ENABLED=true`, it also waits for an iPhone build and includes its IPA and checksum when successful. An iPhone failure is reported in the job summary and does not block the other platforms. Failed builds leave workflow artifacts. No automatic desktop updater is configured.

## Signing

Configure repository **Actions secrets**. Never commit signing keys or certificates.

| Platform | Secrets                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`                                   |
| iPhone   | `APPLE_TEAM_ID`, `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, `IOS_MOBILE_PROVISION`                                                |
| macOS    | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`; optionally `APPLE_SIGNING_IDENTITY` |

**Android:** encode the existing keystore as base64 and keep the same key for updates. Tagged releases require signing. Manual builds without secrets produce an unsigned APK. Signatures and 16 KB alignment are checked before upload.

**iPhone:** set the `IOS_BUILDS_ENABLED` repository variable to `true` to include iPhone builds in tagged releases and manual release validation. The standalone **iPhone app** action is also available. Failed or disabled iPhone builds do not block the other platforms; failed enabled builds produce an explicit warning and no IPA. Use a base64 Apple Distribution `.p12` and provisioning profile for `com.nostr.anagram`. The existing `APPLE_TEAM_ID` can be reused, but the macOS Developer ID Application certificate cannot sign an iOS app. Configure `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD`, and `IOS_MOBILE_PROVISION` separately. Without signing credentials, the asset is explicitly named `-ios-unsigned.ipa` and needs signing before installation. Partial signing configuration fails the build.

The `IOS_EXPORT_METHOD` repository variable defaults to `app-store-connect` for App Store/TestFlight. Use `release-testing` for an ad hoc profile covering registered devices, or `debugging` with development credentials. The workflow builds the IPA; it does not submit it to Apple.

For a local App Store build without a registered device, sign into the team's account in Xcode, generate the iOS project, and run `node scripts/prepare-ios.mjs` and `node scripts/mobile-version.mjs`. Create the archive with:

```sh
npm run tauri -- ios build --ci --target aarch64 --no-sign --archive-only --config src-tauri/mobile-version.json -- --locked
```

Open `src-tauri/gen/apple/build/anagram_iOS.xcarchive` in Xcode and distribute it through App Store Connect. Automatic distribution signing uses the account's App Store certificate/profile permissions; it does not require a development device. The same archive can be exported with `xcodebuild -exportArchive -allowProvisioningUpdates`, using an export options plist with `method=app-store-connect`, `destination=export`, `signingStyle=automatic`, and the team's `teamID`. Keep the marketing version aligned with App Store Connect and increment the build number for subsequent uploads. Exporting an IPA does not submit the app for review.

**macOS:** use a base64 Developer ID Application certificate. Existing secrets `BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD`, and `APPLE_APP_SPECIFIC_PASSWORD` are also accepted. The signing identity is derived from the certificate if omitted. Without a certificate, builds use ad hoc signing. Windows installers are currently unsigned.

See Tauri’s [Android](https://v2.tauri.app/distribute/sign/android/), [iOS](https://v2.tauri.app/distribute/sign/ios/), and [macOS](https://v2.tauri.app/distribute/sign/macos/) signing guides.

## Manual builds

Run **Release** from the Actions tab to validate all active platforms without publishing. On an untagged ref, the optional version input overrides the build version after checking that the committed versions agree; on a tagged ref, the Git tag takes precedence and must match the committed versions. Pushes to `build-validation/**` branches also validate using the package version. Only version-tag pushes can publish a release. Download the `complete-release` artifact to inspect the installers before tagging.

Run **Android APK** for an Android-only build or **iPhone app** for an iOS-only build. The iPhone workflow uploads a `mobile-ios` artifact containing the IPA. Native projects are generated from committed sources. Mobile versions omit RC suffixes, retain the full tag in asset names, and use the workflow run number as the build number. Reruns reuse that number.

## Packaged-app validation

Release publication waits for these checks on the actual packages:

- **Linux / Windows:** extract the AppImage or install the NSIS executable; log in through the native WebView, read a profile, send and receive encrypted DMs, reconnect after a relay disconnect, and restore login/history after restarting. A local relay validates signed events; an unavailable extra relay must not block first login. A separate read-only check requires real EOSE from one default public WSS relay in the packaged WebView.
- **Android:** install the release APK on a fresh Android 15 emulator, require rendered login controls, log in with a disposable key, connect to at least one default WSS relay, and verify login/connectivity after restarting. This is read-only on public relays; no test profile or messages are published. A total public-relay outage can fail the Android and desktop WSS checks.
- **macOS:** verify and mount each architecture's DMG, copy the app, verify its signature, and require a surviving process and rendered Login/Create Account controls, recognized from the native window screenshot. This does not validate relay traffic on macOS.

Failed Android and desktop checks block publication; failed iPhone checks omit only the IPA. Logs, screenshots and result files are retained as `smoke-*` / `android-startup-diagnostics` workflow artifacts. Tests use disposable accounts and never require a developer's saved keys. The iOS build checks the IPA's camera and microphone permission descriptions; physical-device, call and notification behavior still need platform testing. Local web tests alone do not validate installers.

The iPhone workflow also gates packaging on WebKit streaming playback and simulated iPhone/iPad viewport tests. These mock native key storage and keyboard events; they do not establish device permission or locked-screen call support. The iPhone release uses no extra push service and supports messaging/calls while the app is open; background notifications and lock-screen answering are excluded. See the [iPhone scope and device checks](development.md#native-development).

Use a fresh RC tag for each candidate. A failed release run does not replace existing assets, even if the same tag was moved to a newer commit. Check the successful release run before downloading again.

## Running on NixOS

Use `appimage-run ./Anagram_<version>_amd64.AppImage`. It supplies the Linux library environment expected by the AppImage; launching it directly can fail with missing libraries such as `libfontconfig.so.1`.
