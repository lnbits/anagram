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


if __name__ == '__main__':
    unittest.main()
