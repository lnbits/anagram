"""Regression tests for release smoke navigation; no emulator or network needed."""
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
    def prompt(self, message='Allow Anagram to send you notifications?', package='com.google.android.permissioncontroller'):
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
    def test_waits_for_foreground_service_not_just_live_app(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'adb', side_effect=['(nothing)', 'isForeground=false', 'isForeground=true foregroundId=4101']), \
                patch.object(android.time, 'sleep'):
            android.wait_notification_listener()

    def test_fails_when_listener_does_not_start(self):
        with patch.object(android, 'running'), \
                patch.object(android, 'adb', return_value='isForeground=false'), \
                patch.object(android.time, 'monotonic', side_effect=[0, 0, 31]), \
                patch.object(android.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'notification listener did not enter the foreground'):
                android.wait_notification_listener()


if __name__ == '__main__':
    unittest.main()
