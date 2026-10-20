"""Check capture descriptions and the privacy manifest in the final IPA."""
import argparse
import plistlib
import re
import zipfile


CAPTURE_DESCRIPTIONS = ('NSMicrophoneUsageDescription', 'NSCameraUsageDescription')


def validate_ipa(path):
    with zipfile.ZipFile(path) as archive:
        plists = [name for name in archive.namelist()
                  if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', name)]
        if len(plists) != 1:
            raise ValueError('Expected exactly one main application Info.plist in the IPA')
        info = plistlib.loads(archive.read(plists[0]))
        if not isinstance(info, dict):
            raise ValueError('The application Info.plist must be a dictionary')
        for key in CAPTURE_DESCRIPTIONS:
            value = info.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f'Packaged iOS app is missing a non-empty {key}')
        privacy_path = plists[0].rsplit('/', 1)[0] + '/PrivacyInfo.xcprivacy'
        if privacy_path not in archive.namelist():
            raise ValueError('Missing PrivacyInfo.xcprivacy at the root of the app bundle')
        privacy = plistlib.loads(archive.read(privacy_path))
        accessed = privacy.get('NSPrivacyAccessedAPITypes') if isinstance(privacy, dict) else None
        if not isinstance(accessed, list) or not any(
            isinstance(entry, dict)
            and entry.get('NSPrivacyAccessedAPIType') == 'NSPrivacyAccessedAPICategoryFileTimestamp'
            and isinstance(entry.get('NSPrivacyAccessedAPITypeReasons'), list)
            and 'C617.1' in entry['NSPrivacyAccessedAPITypeReasons']
            for entry in accessed
        ):
            raise ValueError('PrivacyInfo.xcprivacy must declare app-container file metadata (C617.1)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    args = parser.parse_args()
    try:
        validate_ipa(args.ipa)
    except (OSError, ValueError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        parser.exit(1, f'iOS permission validation failed: {error}\n')
    print('Packaged iOS capture descriptions and required-reason privacy manifest verified.')
