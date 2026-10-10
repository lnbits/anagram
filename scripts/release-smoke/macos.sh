#!/usr/bin/env bash
# macOS has no free native WKWebView WebDriver. Check the DMG installation and
# rendered login window here; full relay interaction is covered by Windows/Linux/Android.
set -euo pipefail
: "${GITHUB_ACTIONS:?Run in a disposable macOS CI runner}"
dmg="${1:?Pass the release DMG}"
output="${2:-desktop-smoke-results}"
mkdir -p "$output"
shasum -a 256 "$dmg" > "$output/artifact.sha256"
state=$(mktemp -d)
mount="$state/mount"
mkdir "$mount"
pid=''
finish() {
  screencapture -x "$output/screen.png" || true
  [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true
  hdiutil detach "$mount" >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap finish EXIT
hdiutil verify "$dmg" > "$output/dmg-verify.log"
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly
app=$(find "$mount" -maxdepth 1 -name '*.app' -type d)
[[ -n "$app" && $(printf '%s\n' "$app" | wc -l) -eq 1 ]]
ditto "$app" "$state/Anagram.app"
codesign --verify --deep --strict "$state/Anagram.app" > "$output/codesign.log" 2>&1
"$state/Anagram.app/Contents/MacOS/anagram" > "$output/app.log" 2>&1 &
pid=$!
# CGWindowList needs no Accessibility permission and confirms a real on-screen
# native window. A live process alone can miss crashes before window creation.
cat > "$state/window.swift" <<'SWIFT'
import CoreGraphics
import Foundation
import Vision
if CommandLine.arguments.count == 3 {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["en-US"]
  do {
    try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[2])).perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    print(text)
    let normalized = text.lowercased().components(separatedBy: .whitespacesAndNewlines).joined()
    exit(normalized.contains("login") && normalized.contains("createaccount") ? 0 : 1)
  } catch { exit(1) }
}
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let found = windows.first { window in
  guard (window[kCGWindowOwnerPID as String] as? Int) == pid,
        let bounds = window[kCGWindowBounds as String] as? [String: Any],
        let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double else { return false }
  return width >= 360 && height >= 400
}
if let window = found, let id = window[kCGWindowNumber as String] as? Int {
  print(id)
  exit(0)
}
exit(1)
SWIFT
swiftc "$state/window.swift" -o "$state/window"
for attempt in $(seq 1 30); do
  kill -0 "$pid"
  if window_id=$("$state/window" "$pid"); then
    screencapture -x -l "$window_id" "$output/screen.png"
    if ! "$state/window" "$pid" "$output/screen.png" > "$output/ui.txt"; then
      sleep 1
      continue
    fi
    sleep 10
    kill -0 "$pid"
    "$state/window" "$pid"
    echo '{"passed":true,"checks":["dmg-integrity","codesign","installed-app-launch","rendered-login"],"limitation":"No relay interaction on macOS"}' > "$output/result.json"
    exit 0
  fi
  sleep 1
done
echo 'Installed macOS app did not open a window.' >&2
exit 1
