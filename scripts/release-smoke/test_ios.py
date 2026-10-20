from contextlib import chdir
import json
import plistlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ios import choose_device, collect_failure_diagnostics, main, simulator_app, welcome_visible


class SimulatorSmokeTests(unittest.TestCase):
    def test_requires_rendered_welcome_and_login_controls(self):
        self.assertTrue(welcome_visible('Welcome to Anagram\nCreate Account\nLogin with Key'))
        self.assertTrue(welcome_visible('WELCOME TO ANAGRAM\nCreate\nAccount\nLogin with Remote Signer'))

    def test_rejects_blank_screen_or_incomplete_welcome(self):
        self.assertFalse(welcome_visible('19:25'))
        self.assertFalse(welcome_visible('Welcome to Anagram\nCreate Account'))
        self.assertFalse(welcome_visible('Login with Key\nCreate Account'))

    def test_selects_an_available_iphone_in_an_ios_runtime(self):
        phone = {'name': 'iPhone 17', 'isAvailable': True, 'udid': 'test', 'state': 'Shutdown'}
        self.assertEqual(choose_device({
            'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [phone],
            'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
                dict(phone, name='iPad'), dict(phone, isAvailable=False), phone,
            ],
        }, '26.0'), phone)
        with self.assertRaises(RuntimeError):
            choose_device({'com.apple.CoreSimulator.SimRuntime.tvOS-26-0': [phone]}, '26.0')

    def test_matches_build_sdk_instead_of_newest_installed_runtime(self):
        phone = {'name': 'iPhone 16', 'isAvailable': True, 'udid': 'sdk18', 'state': 'Shutdown'}
        newer = dict(phone, name='iPhone 17', udid='sdk26')
        devices = {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [phone],
            'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [dict(phone, udid='sdk18.6')],
            'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [newer],
        }
        self.assertEqual(choose_device(devices, '18.5'), phone)
        self.assertEqual(choose_device(devices, '18.5.0\n'), phone)
        self.assertEqual(choose_device(devices, '26.2'), newer)
        with self.assertRaisesRegex(RuntimeError, 'matching iOS SDK 26.1'):
            choose_device(devices, '26.1')
        devices['com.apple.CoreSimulator.SimRuntime.iOS-18-5'] = [dict(phone, isAvailable=False)]
        with self.assertRaisesRegex(RuntimeError, 'matching iOS SDK 18.5'):
            choose_device(devices, '18.5')

    def test_diagnostic_timeout_does_not_prevent_other_diagnostics(self):
        def run(command, **kwargs):
            if 'screenshot' in command:
                raise subprocess.TimeoutExpired(command, 30)
            kwargs['stdout'].write('simulator diagnostic output\n')

        with tempfile.TemporaryDirectory() as directory, patch('ios.subprocess.run', side_effect=run):
            artifacts = Path(directory)
            collect_failure_diagnostics('test', artifacts)
            self.assertIn('timed out', (artifacts / 'screenshot.log').read_text())
            for name in ('processes.log', 'system.log'):
                self.assertIn('simulator diagnostic output', (artifacts / name).read_text())

    def test_launch_timeout_remains_a_failure_even_if_shutdown_times_out(self):
        phone = {'name': 'iPhone 16', 'isAvailable': True, 'udid': 'sdk18', 'state': 'Shutdown'}
        launch_error = subprocess.TimeoutExpired(['xcrun', 'simctl', 'launch'], 180)

        def check_output(command, **kwargs):
            if '--show-sdk-version' in command:
                return '18.5\n'
            if 'list' in command:
                return json.dumps({'devices': {'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [phone]}})
            if 'launch' in command:
                raise launch_error
            return ''

        def run(command, **kwargs):
            if 'shutdown' in command:
                raise subprocess.TimeoutExpired(command, 60)

        with tempfile.TemporaryDirectory() as directory, chdir(directory), \
                patch('ios.simulator_app', return_value=Path('Anagram.app')), \
                patch('ios.subprocess.check_output', side_effect=check_output), \
                patch('ios.subprocess.run', side_effect=run), \
                patch('ios.collect_failure_diagnostics') as diagnostics:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                main()
            self.assertIs(raised.exception, launch_error)
            artifacts = Path('.artifacts/ios-simulator').resolve()
            diagnostics.assert_called_once_with('sdk18', artifacts)
            self.assertFalse((artifacts / 'result.json').exists())
            self.assertIn('launch', json.loads((artifacts / 'failure.json').read_text())['error'])
            self.assertEqual(json.loads((artifacts / 'device.json').read_text()), phone)

    def test_rejects_device_bundles_and_missing_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'Anagram.app'
            app.mkdir()
            info = {
                'CFBundleIdentifier': 'com.nostr.anagram',
                'CFBundleSupportedPlatforms': ['iPhoneSimulator'],
                'NSCameraUsageDescription': 'Camera for calls',
                'NSMicrophoneUsageDescription': 'Microphone for calls',
            }

            def write(value):
                (app / 'Info.plist').write_bytes(plistlib.dumps(value))

            write(info)
            self.assertEqual(simulator_app(root), app)
            write(dict(info, CFBundleSupportedPlatforms=['iPhoneOS']))
            with self.assertRaisesRegex(RuntimeError, 'not an iPhone simulator'):
                simulator_app(root)
            write(dict(info, NSMicrophoneUsageDescription=''))
            with self.assertRaisesRegex(RuntimeError, 'permission description'):
                simulator_app(root)


if __name__ == '__main__':
    unittest.main()
