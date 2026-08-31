# F-Droid release requirements

## Bottom line

The app is viable for F-Droid, but the repository is not submission-ready yet. The current development branch is substantially closer than the published `v0.5.3` release.

There are two likely acceptance blockers:

1. `v0.5.3` still used Firebase/Google push notifications. F-Droid prohibits proprietary Google/Firebase SDK dependencies. The development branch has already replaced this with direct Nostr relay notifications, so a new Firebase-free release is required.
2. `@nostr-dev-kit/ndk@3.0.3` transitively installs `@codesandbox/nodebox`, whose Sustainable Use License has restrictions incompatible with F-Droid’s all-FLOSS dependency requirement.

F-Droid’s governing requirements are in its [Inclusion Policy](https://f-droid.org/en/docs/Inclusion_Policy/).

## What must be changed

| Priority | Finding | Required action |
|---|---|---|
| Blocker | Published `v0.5.3` contains Firebase/GMS push support | Do not submit that tag. Publish a new release from the current Firebase-free notification implementation. |
| Done | NDK declared Sandpack and non-FLOSS Nodebox | Replaced the unused Sandpack dependency with an empty MIT-licensed package through npm overrides. |
| Done | F-Droid/Fastlane store metadata was missing | Added English descriptions, an icon, phone screenshots, and the version-code `5` changelog upstream. |
| Required | No tested `fdroiddata` build recipe | Create and test a recipe that builds an unsigned release APK entirely from source. |
| Required | Current GitHub Android “release” is a debug APK | Publish a genuine release APK or make it unambiguously test-only. |
| Done | Android identity was inconsistent | Normalized Android, Capacitor, and Electron IDs to `com.nostr.chat`. |
| Important | Production bundles contain the current build timestamp | Make build-time inputs deterministic if reproducible builds are desired. |
| Review | Media uploads use fixed `blossom.nostr.build` | Make the server configurable/discoverable or disclose the network dependency. |
| Legal review | LNbits identifier, name, logo, screenshots and other assets | Confirm that the repository license and distribution permissions cover them all. |

### 1. NDK dependency resolution

The app directly uses NDK in [package.json](../package.json). NDK 3.0.3 declares Sandpack, which normally installs non-FLOSS Nodebox even though the application and NDK runtime do not use Sandpack.

The root npm override now replaces NDK's Sandpack dependency with dependency-free, MIT-licensed `@gitlab/noop@1.0.1`. The lockfile contains no Nodebox package or CodeSandbox tarball resolution, so the restricted package is not fetched during installation.

This differs from deleting the package after installation: npm resolves and downloads the FLOSS no-op package in its place. The override can be removed when an upstream NDK release drops the unused dependency.

The final `fdroid build` and scanner review still need to confirm the complete release dependency closure.

### 2. Make a new Firebase-free release

The current Capacitor application is configured as `com.nostr.chat` in [capacitor.config.json](../src-capacitor/capacitor.config.json), and the current native notification design explicitly avoids Google services in [android-relay-notifications.md](android-relay-notifications.md).

Before submission:

- Keep the staged `0.6.0` version and Android version code `5` synchronized across the root and Capacitor manifests and lockfiles.
- Ensure all package and lock files agree.
- Tag the exact clean commit.
- Verify the tag contains no Firebase, Google Services plugin or Capacitor push-notification dependency.
- Use a monotonically increasing Android version code for every future release.

The package strings in [strings.xml](../src-capacitor/android/app/src/main/res/values/strings.xml) are normalized to `com.nostr.chat`.

### 3. Store metadata

English upstream metadata is available under `fastlane/metadata/android/en-US/`, following F-Droid's [Quick Start Guide](https://f-droid.org/en/docs/Submitting_to_F-Droid_Quick_Start_Guide/) and [graphics/description guide](https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/).

The current layout is:

```text
fastlane/metadata/android/en-US/
├── title.txt
├── short_description.txt
├── full_description.txt
├── changelogs/
│   └── 5.txt
└── images/
    ├── icon.png
    └── phoneScreenshots/
        ├── 1.png
        └── 2.png
```

The approved icon and mobile screenshots are sourced from `public/nostr_chat.png` and `docs/screenshots/`.

The listing discloses:

- Nostr relay usage.
- Background relay connection and notification behavior.
- Foreground-service and boot permissions.
- Configurable Blossom media uploads planned for version `0.6.0`.
- That notifications are direct relay notifications rather than FCM.

### 4. Create the F-Droid build recipe

A new file such as `metadata/com.nostr.chat.yml` will be submitted to the `fdroiddata` repository. It will need:

- Public Git repository URL.
- MIT license declaration.
- Exact version name, version code, tag and full commit hash.
- Node/npm and JDK requirements.
- Root and Capacitor dependency installation.
- Quasar/Capacitor production build and Android synchronization.
- Gradle `assembleRelease`.
- Removal/scanning of generated dependency directories such as `node_modules`.
- Tag-based update checking.

The exact recipe should be tested using the commands described in F-Droid’s [Build Metadata Reference](https://f-droid.org/en/docs/Build_Metadata_Reference/), including `fdroid lint`, `fdroid rewritemeta` and a local `fdroid build`.

The application currently requires Node 24/npm 11, JDK 21 and Android SDK 36-era tooling. The recipe must demonstrate that these can be provisioned reproducibly on F-Droid’s builder.

### 5. Decide the signing strategy

Two approaches are possible:

- **Standard F-Droid signing:** F-Droid builds and signs the APK. Simplest for inclusion, but the F-Droid APK cannot update an upstream-signed or debug installation.
- **Reproducible/upstream signing:** You publish a developer-signed APK, and F-Droid verifies that its build is identical before distributing that APK.

Reproducible builds are recommended but not mandatory; see F-Droid’s [Reproducible Builds documentation](https://f-droid.org/en/docs/Reproducible_Builds/).

The current workflow builds a debug artifact in [release.yml](../.github/workflows/release.yml). That is unsuitable as the permanent public Android release channel.

The timestamp generated in [quasar.config.ts](../quasar.config.ts) should be derived deterministically from the release commit or supplied by both build systems if reproducibility is pursued.

### 6. Review network anti-features

The default Nostr relays in [relays.ts](../src/constants/relays.ts) are user-configurable, so they should not normally make the whole application dependent on one fixed provider.

Media upload is different: [nostrBuildUploadService.ts](../src/services/nostrBuildUploadService.ts) is tied to `blossom.nostr.build`. The safer approach is to let users configure or discover Blossom servers. Otherwise, F-Droid may request a `TetheredNet` or `NonFreeNet` disclosure. Anti-features are warnings and do not automatically cause rejection; see the [Anti-Features policy](https://f-droid.org/en/docs/Anti-Features/).

## What is already in good shape

- The project has a real Capacitor Android target; it does not need to be rewritten in Kotlin.
- The current Android implementation includes meaningful native behavior: foreground service, boot handling and relay notifications.
- The root repository is MIT licensed in [LICENSE](../LICENSE).
- No current ads, analytics or tracking SDKs were found.
- The development branch’s notification implementation no longer depends on Google services.
- Android versioning and release signing are already parameterized through Gradle in [build.gradle](../src-capacitor/android/app/build.gradle).

## Recommended release sequence

1. Remove the Nodebox dependency from the dependency graph.
2. Normalize Android identity and verify asset/brand licensing.
3. Add Fastlane/F-Droid metadata and screenshots.
4. Make build inputs deterministic.
5. Produce and test a genuine unsigned release build from a clean checkout.
6. Run the complete project validation and Android smoke tests.
7. Bump version and `versionCode`, then create a clean Firebase-free tag.
8. Test the F-Droid build recipe in an fdroidserver environment.
9. Submit a merge request to the official `fdroiddata` repository.
10. Respond to scanner/reviewer feedback and document any requested anti-features.

Once the NDK dependency and Firebase-free release issues are resolved, the application looks like a reasonable F-Droid candidate.
