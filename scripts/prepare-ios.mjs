import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

// Run after `tauri ios init`. Keep the generated Xcode project disposable.
const root = fileURLToPath(new URL('../', import.meta.url));
const apple = join(root, 'src-tauri/gen/apple');
const projectFile = join(apple, 'project.yml');
let project = readFileSync(projectFile, 'utf8');
const assetSource = '      - path: Assets.xcassets\n';
if (!project.includes(assetSource)) throw new Error('Unexpected iOS project: missing asset source');
if (!project.includes('      - path: PrivacyInfo.xcprivacy\n')) {
  project = project.replace(
    assetSource,
    assetSource + '      - path: PrivacyInfo.xcprivacy\n        buildPhase: resources\n',
  );
}
// XcodeGen otherwise bundles previously built libapp.a copies as resources.
project = project.replace(
  /      - path: Externals\n(?!        excludes:)/,
  '      - path: Externals\n        excludes: ["**/*.a"]\n',
);
// Cargo's static library does not carry these linker settings into Xcode.
const dependencySource = '      - sdk: CoreGraphics.framework\n';
if (!project.includes(dependencySource)) throw new Error('Unexpected iOS framework list');
for (const sdk of [
  'AVFoundation.framework',
  'Network.framework',
  'SystemConfiguration.framework',
  'libresolv.tbd',
]) {
  const dependency = `      - sdk: ${sdk}\n`;
  if (!project.includes(dependency))
    project = project.replace(dependencySource, dependencySource + dependency);
}
copyFileSync(
  join(root, 'src-tauri/mobile/ios/PrivacyInfo.xcprivacy'),
  join(apple, 'PrivacyInfo.xcprivacy'),
);
writeFileSync(projectFile, project);

const temporary = mkdtempSync(join(tmpdir(), 'anagram-ios-icons-'));
try {
  execFileSync(
    'npm',
    [
      'run',
      'tauri',
      '--',
      'icon',
      'src-tauri/icons/icon.png',
      '--output',
      temporary,
      '--ios-color',
      '#fff',
    ],
    { cwd: root, stdio: 'pipe' },
  );
  const appIcons = join(apple, 'Assets.xcassets/AppIcon.appiconset');
  const manifest = JSON.parse(readFileSync(join(appIcons, 'Contents.json'), 'utf8'));
  for (const filename of new Set(manifest.images.map((entry) => entry.filename))) {
    if (!filename || !/^AppIcon-[\w.@-]+\.png$/.test(filename))
      throw new Error(`Unexpected iOS icon filename: ${filename}`);
    const input = join(temporary, 'ios', filename);
    const image = PNG.sync.read(readFileSync(input));
    // Tauri composites on white, but image-rs can leave alpha=254 from rounding.
    // Reject real transparency and encode RGB for Apple's App Store icon check.
    for (let offset = 3; offset < image.data.length; offset += 4) {
      if (image.data[offset] < 254) throw new Error(`iOS icon is not opaque: ${filename}`);
    }
    writeFileSync(join(appIcons, filename), PNG.sync.write(image, { colorType: 2 }));
    if (readFileSync(join(appIcons, filename))[25] !== 2)
      throw new Error(`iOS icon was not encoded as RGB: ${filename}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

execFileSync('xcodegen', ['generate'], { cwd: apple, stdio: 'inherit' });
// XcodeGen recreates Info.plist; retain the app's capture permission descriptions.
const appInfo = join(apple, 'anagram_iOS/Info.plist');
const readPlist = (path) =>
  JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));
execFileSync('plutil', ['-convert', 'xml1', '-o', appInfo, '-'], {
  input: JSON.stringify({
    ...readPlist(appInfo),
    ...readPlist(join(root, 'src-tauri/Info.plist')),
  }),
});
console.log('Prepared iOS privacy manifest and opaque App Store icons.');
