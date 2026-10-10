#!/usr/bin/env python3
"""Exercise the release APK through Android accessibility, without debug WebView access.

Uses a new local key and reads public relay data only. Does not publish a profile,
relay list or message. At least one configured WSS relay must connect.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

OUTPUT = Path("android-startup-results")
PACKAGE = 'com.nostr.anagram'


def adb(*args, timeout=20, check=True):
    result = subprocess.run(['adb', *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        # Never print command arguments: the generated test key is entered through adb.
        raise RuntimeError('adb operation failed')
    return result.stdout.strip()


def running():
    crash = adb('logcat', '-d', '-b', 'crash')
    if f'Process: {PACKAGE}' in crash or f'>>> {PACKAGE} <<<' in crash:
        raise RuntimeError('Release APK crashed')
    if not adb('shell', 'pidof', PACKAGE, check=False):
        raise RuntimeError('Release APK exited')


def tree():
    running()
    adb('shell', 'uiautomator', 'dump', '/sdcard/anagram-smoke.xml', check=False)
    xml = adb('exec-out', 'cat', '/sdcard/anagram-smoke.xml')
    OUTPUT.joinpath('ui.xml').write_text(xml)
    return ET.fromstring(xml)


def find(label, root):
    return next((node for node in root.iter('node') if label.casefold() in
                 (node.get('text', '').casefold(), node.get('content-desc', '').casefold()) and node.get('enabled') == 'true'), None)


def bounds(node):
    values = tuple(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
    if len(values) != 4:
        raise RuntimeError('Missing accessibility bounds')
    return values


def visible(node, root):
    left, top, right, bottom = bounds(node)
    if right <= left or bottom <= top:
        return False
    webview = next((n for n in root.iter('node')
                    if n.get('class') == 'android.webkit.WebView'), None)
    if webview is None:
        return False
    vl, vt, vr, vb = bounds(webview)
    return vl <= left < right <= vr and vt <= top < bottom <= vb


def scroll_page(root, node=None):
    webview = next((n for n in root.iter('node')
                    if n.get('class') == 'android.webkit.WebView'), None)
    if webview is None:
        return
    left, top, right, bottom = bounds(webview)
    if right <= left or bottom <= top:
        return
    # Swipe in the page gutter, outside the nested relay list, so the whole
    # onboarding page scrolls. WebView may omit off-screen nodes entirely.
    x = left + max(1, (right - left) // 40)
    low = top + (bottom - top) * 4 // 5
    high = top + (bottom - top) // 5
    upwards = node is None or bounds(node)[1] >= top
    start, end = (low, high) if upwards else (high, low)
    adb('shell', 'input', 'swipe', str(x), str(start), str(x), str(end), '350')


def allow_notification_prompt(root):
    # A native Android 13+ prompt obscures WebView accessibility. Match this
    # app's notification request explicitly; never accept unrelated permissions.
    controllers = {'com.android.permissioncontroller', 'com.google.android.permissioncontroller'}
    message = next((node for node in root.iter('node')
                    if node.get('package') in controllers
                    and node.get('resource-id') == 'com.android.permissioncontroller:id/permission_message'
                    and node.get('text') == 'Allow Anagram to send you notifications?'), None)
    if message is None:
        return False
    button = next((node for node in root.iter('node')
                   if node.get('package') == message.get('package')
                   and node.get('resource-id') == 'com.android.permissioncontroller:id/permission_allow_button'
                   and node.get('enabled') == 'true'), None)
    if button is None:
        return False
    tap(button)
    print('Accepted the Android notification permission prompt.')
    return True


def wait(label, seconds=45, scroll=False):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        root = tree()
        if allow_notification_prompt(root):
            time.sleep(0.5)
            continue
        node = find(label, root)
        if node is not None and visible(node, root):
            return node
        if scroll:
            scroll_page(root, node)
        time.sleep(0.5)
    raise RuntimeError(f'Did not render enabled control: {label}')


def tap(node):
    left, top, right, bottom = bounds(node)
    if left < 0 or top < 0 or right <= left or bottom <= top:
        raise RuntimeError('Refusing to tap off-screen accessibility bounds')
    adb('shell', 'input', 'tap', str((left+right)//2), str((top+bottom)//2))


def click(label):
    tap(wait(label, scroll=True))


def wait_notification_listener(seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        running()
        service = adb('shell', 'dumpsys', 'activity', 'services',
                      f'{PACKAGE}/.RelayNotificationService')
        if 'isForeground=true' in service:
            return
        time.sleep(0.5)
    raise RuntimeError('Android notification listener did not enter the foreground')


def main():
    global OUTPUT
    OUTPUT = Path(sys.argv[1])
    if not os.environ.get('ANDROID_SERIAL', '').startswith('emulator-') or adb('shell', 'getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('Requires a disposable emulator')
    click('Create Account')
    click('Login Now')
    wait('Connected', 60)
    click('Next')
    # A random identity has no existing profile. Empty profile + disabled relay-list
    # publication completes onboarding without posting anything on public relays.
    wait('Save and start using app', scroll=True)
    checkbox = wait('Use selected relays for my profile', scroll=True)
    if checkbox.get('class') != 'android.widget.CheckBox':
        raise RuntimeError('Expected the publish-relays checkbox; refusing to publish test data')
    # WebView exposes this HTML checkbox as CheckBox but omits its checked state.
    # The onboarding form starts with publishing enabled; toggle it off once.
    tap(checkbox)
    click('Save and start using app')
    end = time.monotonic() + 45
    while time.monotonic() < end:
        root = tree()
        if allow_notification_prompt(root):
            time.sleep(0.5)
            continue
        if find('settings', root) is not None:
            break
        skip = find('Not now', root)
        if skip is not None:
            click('Not now')
            break
        time.sleep(0.5)
    wait('settings')
    wait_notification_listener()
    adb('shell', 'am', 'force-stop', PACKAGE)
    adb('shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/.MainActivity')
    wait('settings')  # Native keystore identity restored after a real process restart.
    wait_notification_listener()
    click('settings')
    click('Relays')
    click('App Relays')
    wait('Connected', 60)
    running()
    OUTPUT.joinpath('result.json').write_text(json.dumps({
        'passed': True,
        'checks': ['rendered-login', 'native-key-login', 'first-login-wss', 'notification-listener', 'cold-restart', 'notification-listener-after-restart', 'wss-after-restart'],
        'relay_requirement': 'at least one default public WSS relay; read-only',
    }, indent=2))
    print('Release APK passed WSS connectivity, notification listener startup and native identity restoration.')


if __name__ == '__main__':
    main()
