import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { prepareAndroid } from '../../scripts/prepare-android.mjs';
it('regenerates Android notification sources, permissions and tests without duplicate declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anagram-android-scaffold-'));
  const fixtures = {
    'app/build.gradle.kts': `defaultConfig {
        applicationId = "com.nostr.anagram"
      }
      compileSdk = 37
      targetSdk = 37
      optimization { enable = true }
      proguardFiles(
        *fileTree(".") { include("**/*.pro") }.files.toTypedArray()
      )
      dependencies {
        testImplementation("junit:junit:4.13.2")
      }
      `,
    'build.gradle.kts': 'com.android.tools.build:gradle:8.13.2',
    'buildSrc/build.gradle.kts': 'com.android.tools.build:gradle:8.13.2',
    'gradle/wrapper/gradle-wrapper.properties': 'gradle-8.14.3-bin.zip',
    'gradle.properties': '',
    'app/src/main/AndroidManifest.xml': '<manifest><application></application></manifest>',
  };
  const gen = join(dir, 'src-tauri/gen/android');
  try {
    for (const [name, content] of Object.entries(fixtures)) {
      const file = join(gen, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    cpSync(resolve('src-tauri/mobile/android'), join(dir, 'src-tauri/mobile/android'), {
      recursive: true,
    });
    const root = pathToFileURL(dir + '/');
    prepareAndroid(root);
    const manifest = readFileSync(join(gen, 'app/src/main/AndroidManifest.xml'), 'utf8');
    const gradle = readFileSync(join(gen, 'app/build.gradle.kts'), 'utf8');
    prepareAndroid(root);
    expect(readFileSync(join(gen, 'app/src/main/AndroidManifest.xml'), 'utf8')).toBe(manifest);
    expect(readFileSync(join(gen, 'app/build.gradle.kts'), 'utf8')).toBe(gradle);
    for (const name of [
      'POST_NOTIFICATIONS',
      'RECEIVE_BOOT_COMPLETED',
      'FOREGROUND_SERVICE_SPECIAL_USE',
    ])
      expect(manifest).toContain(`android.permission.${name}`);
    expect(manifest).toContain('android:name=".RelayNotificationService" android:exported="false"');
    expect(manifest).toContain('android:name=".CallNotificationReceiver" android:exported="false"');
    expect(gradle).toContain(
      'testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"',
    );
    expect(gradle).toContain('org.json:json:20240303');
    expect(readFileSync(join(gen, 'app/secure-keys.pro'), 'utf8')).toContain('CallSignalNative');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(
      readFileSync(join(gen, 'app/src/main/java/com/nostr/anagram/MainActivity.kt'), 'utf8'),
    ).toBe(readFileSync(resolve('src-tauri/mobile/android/MainActivity.kt'), 'utf8'));
    expect(gradle).toContain('com.squareup.okhttp3:okhttp:4.12.0');
    expect(gradle).toContain('isMinifyEnabled = true');
    expect(gradle).toContain('getDefaultProguardFile("proguard-android-optimize.txt")');
    expect(readFileSync(join(gen, 'app/secure-keys.pro'), 'utf8')).toContain(
      'AndroidRelayNotificationsPlugin',
    );
    expect(
      readFileSync(
        join(gen, 'app/src/main/java/com/nostr/anagram/AndroidRelayNotificationsPlugin.java'),
        'utf8',
      ),
    ).toContain('@TauriPlugin');
    expect(
      readFileSync(
        join(gen, 'app/src/test/java/com/nostr/anagram/Nip44DecryptorTest.java'),
        'utf8',
      ),
    ).toContain('@Test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
