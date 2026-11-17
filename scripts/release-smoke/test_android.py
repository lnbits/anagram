"""Regression tests for release smoke navigation; no emulator or network needed."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

import android


def screen(button_bounds=None, label='Next', enabled='true'):
    root = ET.fromstring('<hierarchy><node class="android.webkit.WebView" '
                         'bounds="[0,24][320,616]" /></hierarchy>')
    if button_bounds:
        ET.SubElement(root[0], 'node', {
            'class': 'android.widget.Button', 'text': label, 'enabled': enabled,
            'bounds': button_bounds,
        })
    return root


class AndroidLoginScreen(unittest.TestCase):
    fixture = Path(__file__).parent / 'fixtures' / 'android-welcome.xml'

    def test_accepts_the_actual_ci_welcome_screen_without_old_login_button(self):
        root = ET.parse(self.fixture).getroot()
        self.assertIsNone(android.find('Login', root))
        self.assertTrue(android.check_login_dump(self.fixture))

    def test_requires_all_enabled_visible_auth_buttons(self):
        for label in ('Create Account', 'Login with Remote Signer', 'Login with Key (not recommended)'):
            for attr, value in (('enabled', 'false'), ('bounds', '[0,0][0,0]'),
                                ('bounds', '[43,632][277,676]'), ('class', 'android.widget.TextView'),
                                ('text', 'Unrelated control')):
                with self.subTest(label=label, attr=attr):
                    root = ET.parse(self.fixture).getroot()
                    android.find(label, root).set(attr, value)
                    self.assertFalse(android.login_screen_ready(root))

    def test_rejects_empty_or_incomplete_accessibility_dump(self):
        self.assertFalse(android.login_screen_ready(ET.fromstring('<hierarchy/>')))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ui.xml'
            self.assertFalse(android.check_login_dump(path))
            path.write_text('<hierarchy>')
            self.assertFalse(android.check_login_dump(path))


class AndroidSmokeNavigation(unittest.TestCase):
    def test_scrolls_before_tapping_ci_offscreen_next(self):
        # Bounds recorded in the failed 320x640 release emulator: the button
        # exists and is enabled, but its top is below the WebView's bottom.
        offscreen = screen('[43,632][277,616]')
        onscreen = screen('[43,432][277,476]')
        with patch.object(android, 'tree', side_effect=[offscreen, onscreen]), \
                patch.object(android, 'adb') as adb, patch.object(android.time, 'sleep'):
            android.click('Next')
        self.assertEqual(adb.call_args_list[0].args,
                         ('shell', 'input', 'swipe', '8', '497', '8', '142', '350'))
        self.assertEqual(adb.call_args_list[1].args,
                         ('shell', 'input', 'tap', '160', '454'))

    def test_scrolls_when_webview_omits_offscreen_button(self):
        with patch.object(android, 'tree', side_effect=[screen(), screen('[43,432][277,476]')]), \
                patch.object(android, 'adb') as adb, patch.object(android.time, 'sleep'):
            android.click('Next')
        self.assertEqual([call.args[2] for call in adb.call_args_list], ['swipe', 'tap'])

    def test_visible_button_needs_no_swipe(self):
        with patch.object(android, 'tree', return_value=screen('[43,432][277,476]')), \
                patch.object(android, 'adb') as adb:
            android.click('Next')
        adb.assert_called_once_with('shell', 'input', 'tap', '160', '454')

    def test_refuses_invalid_tap_bounds(self):
        for value in ['[43,632][277,616]', '[0,0][0,0]', '[43,-10][277,20]']:
            with self.subTest(bounds=value), patch.object(android, 'adb') as adb:
                with self.assertRaises(RuntimeError):
                    android.tap(screen(value)[0][0])
                adb.assert_not_called()

    def test_disabled_button_still_fails(self):
        with patch.object(android, 'tree', return_value=screen('[43,432][277,476]', enabled='false')), \
                patch.object(android.time, 'monotonic', side_effect=[0, 0, 46]), \
                patch.object(android.time, 'sleep'), patch.object(android, 'adb') as adb:
            with self.assertRaisesRegex(RuntimeError, 'Did not render enabled control: Next'):
                android.wait('Next')
        adb.assert_not_called()

    def test_scrolls_back_up_to_control_above_viewport(self):
        root = screen('[43,0][277,20]', label='Use selected relays for my profile')
        with patch.object(android, 'adb') as adb:
            android.scroll_page(root, root[0][0])
        adb.assert_called_once_with('shell', 'input', 'swipe', '8', '142', '8', '497', '350')


class AndroidNotificationPrompt(unittest.TestCase):
    @staticmethod
    def prompt(message='Allow Anagram to send you notifications?', package='com.google.android.permissioncontroller'):
        root = ET.Element('hierarchy')
        ET.SubElement(root, 'node', {
            'package': package, 'text': message,
            'resource-id': 'com.android.permissioncontroller:id/permission_message',
        })
        ET.SubElement(root, 'node', {
            'package': package, 'text': 'Allow', 'enabled': 'true',
            'resource-id': 'com.android.permissioncontroller:id/permission_allow_button',
            'bounds': '[48,323][272,379]',
        })
        return root

    def test_first_login_and_restart_accept_prompt_then_still_require_home(self):
        # Actual failing API 35 accessibility tree: native permissioncontroller,
        # no WebView node until the user answers the notification prompt.
        for package in ('com.google.android.permissioncontroller', 'com.android.permissioncontroller'):
            with self.subTest(package=package), \
                    patch.object(android, 'tree', side_effect=[self.prompt(package=package), screen('[0,550][48,598]', 'settings')]), \
                    patch.object(android, 'adb') as adb, patch.object(android.time, 'sleep'):
                node = android.wait('settings')
                self.assertEqual(node.get('text'), 'settings')
                adb.assert_called_once_with('shell', 'input', 'tap', '160', '351')

    def test_does_not_accept_other_permissions_apps_or_web_buttons(self):
        for root in (
            self.prompt('Allow Anagram to record audio?'),
            self.prompt('Allow Other App to send you notifications?'),
            self.prompt(package='com.nostr.anagram'),
            screen('[48,323][272,379]', 'Allow'),
        ):
            with self.subTest(root=ET.tostring(root)), patch.object(android, 'adb') as adb:
                self.assertFalse(android.allow_notification_prompt(root))
                adb.assert_not_called()

    def test_accepting_notification_permission_does_not_pass_failed_restore(self):
        with patch.object(android, 'tree', side_effect=[self.prompt(), screen('[0,50][100,90]', 'Login')]), \
                patch.object(android.time, 'monotonic', side_effect=[0, 0, 1, 46]), \
                patch.object(android.time, 'sleep'), patch.object(android, 'adb'):
            with self.assertRaisesRegex(RuntimeError, 'Did not render enabled control: settings'):
                android.wait('settings')

    def test_disabled_permission_button_is_not_tapped(self):
        root = self.prompt()
        root[1].set('enabled', 'false')
        with patch.object(android, 'adb') as adb:
            self.assertFalse(android.allow_notification_prompt(root))
            adb.assert_not_called()


class AndroidNotificationListener(unittest.TestCase):
    def test_running_listener_needs_no_permission_prompt(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'tree') as tree, \
                patch.object(android, 'adb', return_value='isForeground=true foregroundId=4101') as adb:
            android.wait_notification_listener()
        tree.assert_not_called()
        adb.assert_called_once_with('shell', 'dumpsys', 'activity', 'services',
                                    f'{android.PACKAGE}/.RelayNotificationService')

    def test_waits_for_foreground_service_not_just_live_app(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'tree', return_value=screen()), \
                patch.object(android, 'adb', side_effect=['(nothing)', 'isForeground=false', 'isForeground=true foregroundId=4101']), \
                patch.object(android.time, 'sleep'):
            android.wait_notification_listener()

    def test_fails_when_listener_does_not_start(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'tree', return_value=screen()), \
                patch.object(android, 'adb', return_value='isForeground=false'), \
                patch.object(android.time, 'monotonic', side_effect=[0, 0, 31]), \
                patch.object(android.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'notification listener did not enter the foreground'):
                android.wait_notification_listener()

    def test_accepts_permission_that_arrives_after_home_then_waits_for_service(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'tree', side_effect=[screen(), AndroidNotificationPrompt.prompt(), screen()]), \
                patch.object(android, 'adb', side_effect=['(nothing)', '(nothing)', '', 'isForeground=false', 'isForeground=true']) as adb, \
                patch.object(android.time, 'sleep'):
            android.wait_notification_listener()
        self.assertEqual(adb.call_args_list[2].args,
                         ('shell', 'input', 'tap', '160', '351'))
        self.assertEqual(sum(call.args[:3] == ('shell', 'dumpsys', 'activity')
                             for call in adb.call_args_list), 4)

    def test_permission_approval_does_not_pass_a_stopped_service(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'tree', return_value=AndroidNotificationPrompt.prompt()) as tree, \
                patch.object(android, 'adb', side_effect=['isForeground=false', '', 'isForeground=false']) as adb, \
                patch.object(android.time, 'monotonic', side_effect=[0, 29, 31, 32, 62]), \
                patch.object(android.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'notification listener did not enter the foreground'):
                android.wait_notification_listener()
        self.assertEqual(adb.call_args_list[1].args,
                         ('shell', 'input', 'tap', '160', '351'))
        self.assertEqual(sum(call.args[:3] == ('shell', 'dumpsys', 'activity')
                             for call in adb.call_args_list), 2)
        # A stale permission dump must not repeatedly renew the startup budget.
        tree.assert_called_once()

    def test_late_permission_gets_a_full_service_start_timeout(self):
        # The dump/tap can finish near the deadline or run past it. In both
        # cases, the service starts only after the original 30-second budget.
        for approval_time in (29.5, 31):
            with self.subTest(approval_time=approval_time), \
                    patch.object(android, 'running'), \
                    patch.object(android, 'tree', return_value=AndroidNotificationPrompt.prompt()) as tree, \
                    patch.object(android, 'adb', side_effect=['(nothing)', '', 'isForeground=false', 'isForeground=true']) as adb, \
                    patch.object(android.time, 'monotonic', side_effect=[0, 29, approval_time, 32, approval_time + 29]), \
                    patch.object(android.time, 'sleep'):
                android.wait_notification_listener()
                self.assertEqual(adb.call_args_list[1].args,
                                 ('shell', 'input', 'tap', '160', '351'))
                self.assertEqual(sum(call.args[:3] == ('shell', 'dumpsys', 'activity')
                                     for call in adb.call_args_list), 3)
                tree.assert_called_once()


if __name__ == '__main__':
    unittest.main()
