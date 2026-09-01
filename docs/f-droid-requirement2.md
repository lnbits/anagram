There are two separate repositories involved:

  - lnbits/nostr-chat: the authoritative source and release tags.
  - fdroid/fdroiddata: the packaging recipe that tells F-Droid how to rebuild and publish Anagram.

  Do the upstream release first, then submit the packaging recipe.

  ## A. Finish this app repository

  ### 1. Complete the paused asset review

  Before release, replace or clear the rights for:

  - docs/screenshots/mobile-groups.png
  - fastlane/metadata/android/en-US/images/phoneScreenshots/2.png

  That screenshot contains Firefox logos and a personal-looking group avatar. The safer solution is a fresh screenshot using synthetic names, initial-based avatars, and no third-party logos.

  Already verified:

  - Manrope is byte-identical to the official OFL-1.1 font.
  - Space Grotesk is byte-identical to the official OFL-1.1 font.
  - public/lnbits.svg is byte-identical to the logo in the official lnbits/lnbits repository.
  - The F-Droid icon is a copy of public/nostr_chat.png.
  - Phone screenshot 1 is a copy of docs/screenshots/mobile-chats.png.

  Add an asset-provenance document before submission, recording the first-party images under the repository’s MIT license and both fonts under OFL-1.1.

  ### 2. Finish and commit the current work

  The working tree currently has unfinished application and test changes. Do not create the F-Droid release tag until:

  git status --short

  is clean and the intended work has been merged into dev or main.

  The release workflow only accepts tags whose commits are reachable from those branches.

  ### 3. Bump the release version

  The current manifests still say 0.6.1 and Android version code 6. The planned release should become 0.6.2 / code 7:

  npm run version:bump -- 0.6.2 --android-version-code=7

  This should update:

  - package.json
  - package-lock.json
  - src-capacitor/package.json
  - src-capacitor/package-lock.json

  Confirm:

  rg -n '"version"|"androidVersionCode"' \
    package.json package-lock.json \
    src-capacitor/package.json src-capacitor/package-lock.json

  ### 4. Add the Android changelog

  Create:

  fastlane/metadata/android/en-US/changelogs/7.txt

  Keep it under 500 characters. For example:

  Version 0.6.2

  - Renamed the app to Anagram.
  - Added configurable Blossom media storage.
  - Improved chat presentation, reactions, unread state, and reconnection behavior.
  - Prepared the Android release for F-Droid.

  Ensure the store description, screenshots, and release functionality all describe the same tagged version.

  ### 5. Run the full release validation

  Because the current work spans multiple user-visible and relay-sensitive areas:

  npm run quality:all
  npm run test:unit
  npm run test:e2e:local
  npm run build:android:apk:release

  Also install an Android debug or locally signed release build on a device/emulator and manually verify:

  - Account creation and private-key login.
  - Secure private-key restoration after restart.
  - Direct messages and groups.
  - Relay selection and reconnection.
  - Configurable Blossom uploads.
  - Notification permission flow.
  - Foreground relay service.
  - Restart-after-boot behavior.
  - No dependency on Google Play Services or Firebase.

  ### 6. Create the immutable release

  After merging and pushing the release commit:

  git status --short
  git tag -a v0.6.2 -m "Anagram 0.6.2"
  git push origin v0.6.2

  Do not move or reuse v0.6.1.

  Record the exact release commit:

  git rev-list -n 1 v0.6.2

  You will use that full 40-character SHA in fdroiddata.

  Confirm that the GitHub release workflow succeeds. Its Android APK should remain clearly marked as debug/test-only; F-Droid will build and sign the production APK.

  ## B. Finalize the F-Droid recipe

  The draft is currently in metadata/com.nostr.chat.yml:1.

  ### 7. Retarget the recipe to v0.6.2

  Change the build block to:

  Builds:
    - versionName: 0.6.2
      versionCode: 7
      commit: FULL_40_CHARACTER_V0.6.2_COMMIT_SHA

  Also update:

  CurrentVersion: 0.6.2
  CurrentVersionCode: 7

  Add the LNbits site as author identity evidence:

  AuthorName: LNbits
  AuthorWebSite: https://lnbits.com

  Keep:

  Repo: https://github.com/lnbits/nostr-chat.git
  UpdateCheckMode: Tags ^v[0-9.]+$

  Remove the obsolete note saying the recipe targets a post-v0.6.1 technical baseline. It can be replaced with something useful to reviewers:

  MaintainerNotes: |-
    npm lifecycle scripts are disabled during dependency installation.
    esbuild and Rolldown native executables are rebuilt from the declared
    source libraries. The application contains no Firebase, GMS, advertising,
    analytics, or tracking SDKs.

  Keep srclibs/rolldown.yml:1, because the recipe uses it to rebuild Rolldown instead of accepting its npm native binary.

  ## C. Work in fdroid/fdroiddata

  ### 8. Create a GitLab fork

  Open:

  https://gitlab.com/fdroid/fdroiddata

  Sign into GitLab and select Fork. The resulting repository will look like:

  https://gitlab.com/YOUR_GITLAB_USERNAME/fdroiddata

  Clone your fork:

  git clone https://gitlab.com/YOUR_GITLAB_USERNAME/fdroiddata.git
  cd fdroiddata
  git remote add upstream https://gitlab.com/fdroid/fdroiddata.git
  git fetch upstream
  git switch -c com.nostr.chat upstream/master

  Do not attempt to push directly to the official repository.

  ### 9. Copy the recipe into the fork

  From the fdroiddata checkout:

  cp /Users/moto/Documents/GitHub/motorina0/xyz/metadata/com.nostr.chat.yml \
    metadata/com.nostr.chat.yml

  For Rolldown, first check whether another contributor has added it:

  test -f srclibs/rolldown.yml && sed -n '1,120p' srclibs/rolldown.yml

  If it does not exist:

  cp /Users/moto/Documents/GitHub/motorina0/xyz/srclibs/rolldown.yml \
    srclibs/rolldown.yml

  If it already exists, compare the existing definition and use the upstream version instead of overwriting it blindly.

  Do not copy the Fastlane files into fdroiddata; F-Droid reads them from the tagged application source.

  ### 10. Get fdroidserver

  In the directory beside your fdroiddata checkout:

  git clone --depth=1 https://gitlab.com/fdroid/fdroidserver.git

  Your layout should be:

  working-directory/
  ├── fdroiddata/
  └── fdroidserver/

  ### 11. Start F-Droid’s official build container

  From working-directory/:

  docker run --rm -it \
    --entrypoint /bin/bash \
    -v "$PWD/fdroiddata:/build" \
    -v "$PWD/fdroidserver:/home/vagrant/fdroidserver" \
    registry.gitlab.com/fdroid/fdroidserver:buildserver

  Inside the container:

  . /etc/profile
  export PATH="/home/vagrant/fdroidserver:$PATH"
  export PYTHONPATH="/home/vagrant/fdroidserver"
  cd /build

  ### 12. Parse, format, and lint the metadata

  Run inside the container:

  fdroid readmeta
  fdroid rewritemeta com.nostr.chat
  fdroid checkupdates --allow-dirty com.nostr.chat
  fdroid lint com.nostr.chat

  After rewritemeta, inspect the changes outside the container:

  git diff -- metadata/com.nostr.chat.yml srclibs/rolldown.yml

  Keep the canonical formatting generated by fdroid rewritemeta.

  checkupdates should identify v0.6.2, version 0.6.2, and code 7. If it does not, fix UpdateCheckData before proceeding.

  ### 13. Run the actual isolated F-Droid build

  Inside the container:

  fdroid build --on-server --no-tarball -v com.nostr.chat:7

  Success means F-Droid:

  - Checks out the exact v0.6.2 commit.
  - Installs npm dependencies without lifecycle scripts.
  - Scans the source and dependencies.
  - Rebuilds esbuild and Rolldown from source.
  - Runs the Quasar/Capacitor build.
  - Runs Gradle assembleRelease.
  - Produces an unsigned com.nostr.chat APK with version code 7.

  Do not accept a build that only works against the old 840eb8d… technical-baseline commit.

  ### 14. Test the generated APK

  Check its package identity:

  aapt dump badging unsigned/com.nostr.chat_7.apk

  Confirm it reports:

  package: name='com.nostr.chat' versionCode='7' versionName='0.6.2'

  The APK should be unsigned because standard F-Droid signing happens after the source build.

  If available in the container, also run:

  fdroid scanner unsigned/com.nostr.chat_7.apk

  ### 15. Commit the fdroiddata contribution

  Outside the container:

  git status --short
  git add metadata/com.nostr.chat.yml

  If Rolldown was newly added:

  git add srclibs/rolldown.yml

  Then:

  git commit -m "New App: com.nostr.chat"
  git push -u origin com.nostr.chat

  ### 16. Open the merge request

  In GitLab, open a merge request:

  - Source: your fork’s com.nostr.chat branch.
  - Target: fdroid/fdroiddata → master.
  - Title: New App: com.nostr.chat
  - Label: New App, if available.

  The description should mention:

  - You are submitting with upstream/LNbits authorization.
  - LNbits controls nostr.com, supporting com.nostr.chat.
  - Source is MIT licensed.
  - Fonts are OFL-1.1 and their license files are included.
  - Store graphics are first-party or documented.
  - There is no Firebase, GMS, advertising, analytics, or tracking.
  - Relay notifications connect directly to configurable Nostr relays.
  - Blossom storage is configurable.
  - The Sandpack dependency is replaced before npm downloads Nodebox.
  - esbuild and Rolldown are rebuilt from source.
  - Why the Capacitor archive needs scanignore.
  - The package intentionally uses standard F-Droid signing.
  - The exact build command you ran and that it succeeded.

  Do not upload an APK to the merge request and do not add Binaries or AllowedAPKSigningKeys when using standard F-Droid signing.

  ### 17. Respond to review

  Reviewers may ask for:

  - Proof or clarification of asset rights.
  - A clearer reason for scanignore.
  - Changes to the Node/Rust build recipe.
  - Anti-feature disclosure.
  - A different srclib arrangement.
  - Re-running the recipe after changes.

  Push fixes to the same branch; the merge request updates automatically.

  Once the merge request is accepted, F-Droid’s build infrastructure will rebuild the tagged source, sign the APK with F-Droid’s key, and publish it. The authoritative process is documented in the F-Droid submission
  guide.