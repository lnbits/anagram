"""Exercise the release guard against the binary plist layout shipped in IPAs."""
import io
import plistlib
from pathlib import Path
import unittest
import zipfile

from ios_permissions import CAPTURE_DESCRIPTIONS, validate_ipa


class IosPermissionPackaging(unittest.TestCase):
    def ipa(self, info, fmt=plistlib.FMT_BINARY, path='Payload/Anagram.app/Info.plist'):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr(path, plistlib.dumps(info, fmt=fmt))
        output.seek(0)
        return output

    def test_accepts_binary_and_xml_plists_with_current_app_descriptions(self):
        path = Path(__file__).resolve().parents[2] / 'src-tauri' / 'Info.plist'
        with path.open('rb') as source:
            info = plistlib.load(source)
        for fmt in (plistlib.FMT_BINARY, plistlib.FMT_XML):
            with self.subTest(format=fmt):
                validate_ipa(self.ipa(info, fmt))

    def test_rejects_each_missing_empty_or_non_string_description(self):
        for key in CAPTURE_DESCRIPTIONS:
            for value in (None, '', '  ', True):
                info = dict.fromkeys(CAPTURE_DESCRIPTIONS, 'Used during your call')
                if value is None:
                    del info[key]
                else:
                    info[key] = value
                with self.subTest(key=key, value=value):
                    with self.assertRaisesRegex(ValueError, key):
                        validate_ipa(self.ipa(info))

    def test_does_not_accept_descriptions_from_an_embedded_extension(self):
        info = dict.fromkeys(CAPTURE_DESCRIPTIONS, 'Extension permissions')
        with self.assertRaisesRegex(ValueError, 'exactly one main application'):
            validate_ipa(self.ipa(info, path='Payload/Anagram.app/PlugIns/Share.appex/Info.plist'))

    def test_rejects_multiple_main_apps(self):
        output = self.ipa(dict.fromkeys(CAPTURE_DESCRIPTIONS, 'Call permissions'))
        with zipfile.ZipFile(output, 'a') as archive:
            archive.writestr('Payload/Other.app/Info.plist', plistlib.dumps({}))
        output.seek(0)
        with self.assertRaisesRegex(ValueError, 'exactly one main application'):
            validate_ipa(output)


if __name__ == '__main__':
    unittest.main()
