"""Check capture usage descriptions in the final IPA, without extracting it."""
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    args = parser.parse_args()
    try:
        validate_ipa(args.ipa)
    except (OSError, ValueError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        parser.exit(1, f'iOS permission validation failed: {error}\n')
    print('Packaged iOS microphone and camera usage descriptions verified.')
