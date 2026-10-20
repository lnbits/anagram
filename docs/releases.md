# Releases

Tag the desired commit and push the tag to run [release.yml](../.github/workflows/release.yml). CI takes the version from the tag, updates the version files in its build checkout, then checks they match. No version-bump commit is required. Branch and pull-request CI checks that committed app versions agree with `package.json`.

For local builds, use `npm run release:version -- v0.9.1`. It updates `package.json`, both root version fields in `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`. An existing `src-tauri/mobile-version.json` gets the numeric marketing version while retaining its build numbers. `npm run release:check -- v0.9.1` checks without writing. Rebuild generated native projects and web bundles after a local version change.

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

## Mac App Store and Mac TestFlight

Use `src-tauri/tauri.appstore.conf.json` for the sandboxed store build. It packages the privacy manifest and enables the camera, microphone, selected-file, and network permissions. Incoming network access supports Iroh's UDP transport. The deployment target is macOS 11; audio/video calls also depend on the installed WebKit media and codec support. The ordinary DMG build continues to use its existing configuration.

Install both Rust targets and build a universal app. Set a new build number for each upload, keeping the marketing version aligned with App Store Connect:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
APPLE_SIGNING_IDENTITY=- npm run tauri -- build \
  --target universal-apple-darwin \
  --config src-tauri/tauri.appstore.conf.json \
  --config '{"bundle":{"macOS":{"bundleVersion":"1"}}}' -- --locked
python3 scripts/archive-macos-appstore.py --team-id LC2GBL34NL
```

The archive helper checks the architectures, signature, sandbox entitlement, and privacy manifest. It refuses to overwrite an existing archive. Use `--output` to keep separate release candidates.

Sign into the team's Apple Developer account in Xcode, with permission to use distribution signing. Export the archive through Xcode's automatic signing:

```sh
xcodebuild -exportArchive \
  -archivePath .artifacts/macos-appstore/Anagram-0.9.7-1.xcarchive \
  -exportPath .artifacts/macos-appstore/export \
  -exportOptionsPlist .artifacts/macos-appstore/ExportOptions.plist \
  -allowProvisioningUpdates
pkgutil --check-signature .artifacts/macos-appstore/export/Anagram.pkg
```

Replace the archive version and build number in these examples for later releases. Xcode can use the team's cloud-managed Mac App Store application and installer certificates and provisioning profile. The ad hoc archive is only an intermediate artifact; use the exported, distribution-signed package for uploading.

To upload to App Store Connect, repeat `xcodebuild -exportArchive` with `UploadOptions.plist` and a separate `-exportPath`. Uploading does not submit a public store release. After processing, complete encryption compliance, attach the build to the intended TestFlight group, and request beta review when needed. Encryption keys are intentionally omitted so Apple's questionnaire is completed for each build; do not set `ITSAppUsesNonExemptEncryption=true` without the matching approved compliance code. See [Apple's encryption key documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption). Test the actual sandboxed Mac app, including login persistence, relays, attachments, camera/microphone permissions, and calls before submitting it for public review.

Keep archives, packages, provisioning profiles, and logs under the ignored `.artifacts/` directory. Store availability, pricing, screenshots, privacy disclosures, and manual release settings are managed separately in App Store Connect.

## Manual builds

Run **Release** from the Actions tab to validate all active platforms without publishing. On an untagged ref, the optional version input sets the build version; on a tagged ref, the Git tag takes precedence. Pushes to `build-validation/**` branches validate using the package version. Only version-tag pushes can publish a release. Download the `complete-release` artifact to inspect the installers before tagging.

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
