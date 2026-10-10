#!/usr/bin/env bash
set -euo pipefail
mapfile -t apks < <(find src-tauri/gen/android/app/build/outputs/apk -name '*-release-unsigned.apk' -type f)
[[ ${#apks[@]} -eq 1 ]] || { echo 'Expected one universal release APK'; exit 1; }
mkdir -p mobile-assets
version=$(node -p 'require("./package.json").version')
output="mobile-assets/anagram-${version}-android.apk"
if [[ -z "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  if [[ -n "${RELEASE_TAG:-}" ]]; then
    echo 'Tagged Android releases require ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD.' >&2
    exit 1
  fi
  cp "${apks[0]}" "mobile-assets/anagram-${version}-android-unsigned.apk"
  echo 'Unsigned workflow artifact: configure Android signing secrets for an installable APK.'
  exit 0
fi
: "${ANDROID_KEYSTORE_PASSWORD:?Missing Android keystore password}"
: "${ANDROID_KEY_ALIAS:?Missing Android key alias}"
: "${ANDROID_KEY_PASSWORD:?Missing Android key password}"
umask 077
printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$RUNNER_TEMP/anagram-signing.jks"
build_tools="$ANDROID_HOME/build-tools/35.0.0"
"$build_tools/zipalign" -f -P 16 4 "${apks[0]}" "$RUNNER_TEMP/anagram-aligned.apk"
bash "$build_tools/apksigner" sign --ks "$RUNNER_TEMP/anagram-signing.jks" \
  --ks-key-alias "$ANDROID_KEY_ALIAS" --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --key-pass env:ANDROID_KEY_PASSWORD --out "$output" "$RUNNER_TEMP/anagram-aligned.apk"
bash "$build_tools/apksigner" verify "$output"
"$build_tools/zipalign" -c -P 16 4 "$output"
