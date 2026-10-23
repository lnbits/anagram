#!/usr/bin/env python3
"""Wrap a built universal Tauri app in an archive for Xcode automatic signing."""

import argparse
import datetime
import plistlib
import re
import subprocess
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--team-id", required=True)
    parser.add_argument(
        "--app",
        type=Path,
        default=repo
        / "src-tauri/target/universal-apple-darwin/release/bundle/macos/Anagram.app",
    )
    parser.add_argument("--output", type=Path, default=repo / ".artifacts/macos-appstore")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Z0-9]{10}", args.team_id):
        parser.error("--team-id must be the 10-character Apple Developer team ID")

    app = args.app.resolve()
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    architectures = subprocess.check_output(
        ["lipo", "-archs", str(executable)], text=True
    ).split()
    if set(architectures) != {"arm64", "x86_64"}:
        parser.error("build a universal app containing arm64 and x86_64 first")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    entitlements = plistlib.loads(
        subprocess.check_output(
            ["codesign", "-d", "--entitlements", ":-", str(app)],
            stderr=subprocess.PIPE,
        )
    )
    if entitlements.get("com.apple.security.app-sandbox") is not True:
        parser.error("app is missing the Mac App Store sandbox entitlement")
    if not (app / "Contents/Resources/PrivacyInfo.xcprivacy").is_file():
        parser.error("app is missing its privacy manifest")

    version, build = info["CFBundleShortVersionString"], info["CFBundleVersion"]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"Anagram-{version}-{build}.xcarchive"
    archive.mkdir()  # Refuse to replace a previous release archive.
    applications = archive / "Products/Applications"
    applications.mkdir(parents=True)
    subprocess.run(["ditto", str(app), str(applications / app.name)], check=True)
    manifest = {
        "ArchiveVersion": 2,
        "CreationDate": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
        "Name": "Anagram",
        "SchemeName": "Anagram",
        "ApplicationProperties": {
            "ApplicationPath": f"Applications/{app.name}",
            "Architectures": architectures,
            "CFBundleIdentifier": info["CFBundleIdentifier"],
            "CFBundleShortVersionString": version,
            "CFBundleVersion": build,
            "SigningIdentity": "-",
            "Team": args.team_id,
        },
    }
    (archive / "Info.plist").write_bytes(plistlib.dumps(manifest))
    options = {
        "method": "app-store-connect",
        "destination": "export",
        "signingStyle": "automatic",
        "teamID": args.team_id,
        "manageAppVersionAndBuildNumber": False,
        # The default Cargo release profile does not produce dSYMs.
        "uploadSymbols": False,
        "generateAppStoreInformation": True,
    }
    (output / "ExportOptions.plist").write_bytes(plistlib.dumps(options))
    options["destination"] = "upload"
    (output / "UploadOptions.plist").write_bytes(plistlib.dumps(options))
    print(f"Archive: {archive}")
    print(f"Export/upload options: {output}")


if __name__ == "__main__":
    main()
