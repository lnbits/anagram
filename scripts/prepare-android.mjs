import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function prepareAndroid(root = new URL('../', import.meta.url)) {
  // Keep generated scaffolding on released Android tooling. The CLI template
  // currently requests API 37, which sdkmanager cannot install from stable.
  const gradle = new URL('src-tauri/gen/android/app/build.gradle.kts', root);
  writeFileSync(
    gradle,
    readFileSync(gradle, 'utf8')
      .replace(
        /(testImplementation\("junit:junit:4.13.2"\))(?!\n    testImplementation\("org.json)/,
        '$1\n    testImplementation("org.json:json:20240303")',
      )
      .replace(
        /(defaultConfig \{\n)(?!        testInstrumentationRunner)/,
        '$1        testInstrumentationRunner = \"androidx.test.runner.AndroidJUnitRunner\"\n',
      )
      .replace(/compileSdk = \d+/, 'compileSdk = 36')
      .replace(/targetSdk = \d+/, 'targetSdk = 36')
      .replace(/optimization\s*\{\s*enable = true\s*\}/, 'isMinifyEnabled = true')
      // AGP 8 needs the default Android rules explicitly. Without them R8
      // removes enum values() used reflectively by Jackson during Tauri startup.
      .replace(
        /proguardFiles\(\s*(?=\*fileTree)/,
        'proguardFiles(\n                getDefaultProguardFile("proguard-android-optimize.txt"),\n                ',
      )
      .replace(
        /(dependencies \{\n)(?!    implementation\("com.squareup.okhttp3:okhttp:4.12.0"\))/,
        '$1    implementation("com.squareup.okhttp3:okhttp:4.12.0")\n',
      ),
  );
  const project = new URL('src-tauri/gen/android/build.gradle.kts', root);
  writeFileSync(
    project,
    readFileSync(project, 'utf8').replace(
      /com.android.tools.build:gradle:[^"\s]+/,
      'com.android.tools.build:gradle:8.11.1',
    ),
  );
  const buildSrc = new URL('src-tauri/gen/android/buildSrc/build.gradle.kts', root);
  writeFileSync(
    buildSrc,
    readFileSync(buildSrc, 'utf8').replace(
      /com.android.tools.build:gradle:[^"\s]+/,
      'com.android.tools.build:gradle:8.11.1',
    ),
  );
  writeFileSync(
    new URL('src-tauri/gen/android/app/secure-keys.pro', root),
    '-keep class com.nostr.anagram.SecureKeysPlugin { *; }\n-keep class com.nostr.anagram.PrivateKeyArgs { *; }\n-keep class com.nostr.anagram.AndroidRelayNotificationsPlugin { *; }\n-keep class com.nostr.anagram.CallSignalNative { *; }\n',
  );
  const wrapper = new URL('src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties', root);
  writeFileSync(
    wrapper,
    readFileSync(wrapper, 'utf8').replace(/gradle-[\d.]+-bin.zip/, 'gradle-8.13-bin.zip'),
  );
  const properties = new URL('src-tauri/gen/android/gradle.properties', root);
  const gradleProperties = readFileSync(properties, 'utf8');
  if (!gradleProperties.includes('android.useAndroidX=true'))
    writeFileSync(properties, gradleProperties + '\nandroid.useAndroidX=true\n');
  const manifest = new URL('src-tauri/gen/android/app/src/main/AndroidManifest.xml', root);
  let xml = readFileSync(manifest, 'utf8');
  for (const name of [
    'RECORD_AUDIO',
    'CAMERA',
    'MODIFY_AUDIO_SETTINGS',
    'ACCESS_NETWORK_STATE',
    'POST_NOTIFICATIONS',
    'RECEIVE_BOOT_COMPLETED',
    'FOREGROUND_SERVICE',
    'FOREGROUND_SERVICE_SPECIAL_USE',
  ]) {
    if (!xml.includes(`android.permission.${name}`))
      xml = xml.replace(
        '<application',
        `<uses-permission android:name="android.permission.${name}" />\n    <application`,
      );
  }
  // Camera/microphone are optional: messaging must install on devices without them.
  for (const name of ['android.hardware.camera', 'android.hardware.microphone']) {
    if (!xml.includes(`android:name="${name}"`))
      xml = xml.replace(
        '<application',
        `<uses-feature android:name="${name}" android:required="false" />\n    <application`,
      );
  }
  if (!xml.includes('android:allowBackup='))
    xml = xml.replace('<application', '<application android:allowBackup="false"');
  if (!xml.includes('android:name=".RelayNotificationService"'))
    xml = xml.replace(
      '</application>',
      `<service android:name=".RelayNotificationService" android:exported="false" android:foregroundServiceType="specialUse" android:stopWithTask="false">
      <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="User-enabled Nostr relay subscriptions for private message notifications." />
    </service>
    <receiver android:name=".BootCompletedReceiver" android:enabled="true" android:exported="true">
      <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>
    </receiver>
    <receiver android:name=".NotificationDismissReceiver" android:exported="false" />
    </application>`,
    );
  if (!xml.includes('android:name=".CallNotificationReceiver"'))
    xml = xml.replace(
      '</application>',
      '<receiver android:name=".CallNotificationReceiver" android:exported="false" />\n    </application>',
    );
  writeFileSync(manifest, xml);
  const java = new URL('src-tauri/gen/android/app/src/main/java/com/nostr/anagram/', root);
  mkdirSync(java, { recursive: true });
  const native = new URL('src-tauri/mobile/android/', root);
  for (const file of readdirSync(native).filter((name) => /\.(kt|java)$/.test(name)))
    copyFileSync(new URL(file, native), new URL(file, java));
  cpSync(new URL('res/', native), new URL('src-tauri/gen/android/app/src/main/res/', root), {
    recursive: true,
  });
  cpSync(
    new URL('instrumentation/', native),
    new URL('src-tauri/gen/android/app/src/androidTest/java/com/nostr/anagram/', root),
    { recursive: true },
  );
  cpSync(
    new URL('tests/', native),
    new URL('src-tauri/gen/android/app/src/test/java/com/nostr/anagram/', root),
    { recursive: true },
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) prepareAndroid();
