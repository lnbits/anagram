#!/usr/bin/env bash
# Run against a fresh, already booted emulator. Never use a user's phone/account.
set -euo pipefail
adb() { timeout --kill-after=3s 30 adb "$@"; }
apk="${1:?Pass the release APK to test}"
output="${2:-android-startup-results}"
: "${ANDROID_SERIAL:?Select the disposable emulator with ANDROID_SERIAL}"
[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || {
  echo 'Startup tests require a disposable emulator.' >&2
  exit 1
}
mkdir -p "$output"
rm -f "$output/result.json"
sha256sum "$apk" > "$output/artifact.sha256"
test_temp=$(mktemp -d)
finish() {
  timeout 10 adb logcat -d > "$output/logcat.txt" 2>&1 || true
  timeout 10 adb logcat -d -b crash > "$output/crash.txt" 2>&1 || true
  timeout 10 adb exec-out screencap -p > "$output/screen.png" 2>/dev/null || true
  rm -rf "$test_temp"
}
trap finish EXIT

# Manual workflows can produce unsigned APKs. Sign a separate test copy;
# tagged releases are tested with their original release signature.
build_tools="${ANDROID_HOME:?}/build-tools/35.0.0"
if ! bash "$build_tools/apksigner" verify "$apk" >/dev/null 2>&1; then
  keytool -genkeypair -keystore "$test_temp/test.jks" -storepass android \
    -keypass android -alias test -dname 'CN=Anagram Emulator Test' \
    -keyalg RSA -validity 2 >/dev/null 2>&1
  bash "$build_tools/apksigner" sign --ks "$test_temp/test.jks" \
    --ks-pass pass:android --key-pass pass:android \
    --out "$test_temp/test.apk" "$apk"
  apk="$test_temp/test.apk"
fi
# Remove prior smoke installs (manual test copies may use a new temporary key).
adb uninstall com.nostr.anagram >/dev/null 2>&1 || true
adb install --no-incremental "$apk"
# This emulator is disposable: ensure first launch is genuinely a clean install.
adb shell pm clear com.nostr.anagram
adb logcat -c
adb shell am force-stop com.nostr.anagram
timeout 20 adb shell am start -W -n com.nostr.anagram/.MainActivity > "$output/launch.txt"

# am start can report success even when startup immediately crashes back to
# the launcher. Require a live process AND the rendered web login controls.
check_running() {
  adb logcat -d -b crash > "$output/crash.txt"
  if grep -Eq 'Process: com\.nostr\.anagram|>>> com\.nostr\.anagram <<<' "$output/crash.txt"; then
    echo 'Anagram crashed during startup.' >&2
    exit 1
  fi
  if ! adb shell pidof com.nostr.anagram >/dev/null; then
    echo 'Anagram exited during startup.' >&2
    exit 1
  fi
}
for attempt in $(seq 1 30); do
  check_running
  timeout 10 adb shell uiautomator dump /sdcard/anagram-startup.xml >/dev/null 2>&1 || true
  adb exec-out cat /sdcard/anagram-startup.xml > "$output/ui.xml" 2>/dev/null || true
  if grep -q 'text="Login"' "$output/ui.xml" && grep -q 'text="Create Account"' "$output/ui.xml"; then
    # Also catch failures shortly after the page first appears.
    sleep 3
    check_running
    echo 'Release APK reached the rendered login screen and stayed running.'
    python3 "$(dirname "$0")/release-smoke/android.py" "$output"
    exit 0
  fi
  sleep 1
done
echo 'Anagram did not render its login screen.' >&2
exit 1
