import importlib.util
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'package_android_gradle', Path(__file__).parents[1] / 'ci/package_android_gradle.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class AndroidGradleArtifactTests(unittest.TestCase):
    def test_project_works_without_original_build_or_cargo_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / 'original'
            project = original / 'android'
            library = original / 'registry/tauri/mobile/android'
            library.mkdir(parents=True)
            (library / 'build.gradle.kts').write_text('android library')
            (library / 'build').mkdir()
            (library / 'build/cache').write_text('discard')
            jni = project / 'app/src/main/jniLibs/arm64-v8a'
            jni.mkdir(parents=True)
            native = original / 'libanagram.so'
            native.write_bytes(b'native library')
            (jni / native.name).symlink_to(native)
            (project / 'gradlew').write_text('#!/bin/sh\n')
            (project / 'gradlew').chmod(0o755)
            (project / 'local.properties').write_text('sdk.dir=/old/sdk')
            (project / 'tauri.settings.gradle').write_text(
                f'include \':tauri-android\'\n'
                f'project(\':tauri-android\').projectDir = new File("{library}")\n')
            archive = root / 'project.tar.gz'
            packaging.package_project(project, archive)
            shutil.rmtree(original)
            with tarfile.open(archive) as bundle:
                bundle.extractall(root / 'restored', filter='data')
            restored = root / 'restored/android'
            self.assertEqual((restored / 'app/src/main/jniLibs/arm64-v8a/libanagram.so').read_bytes(),
                             b'native library')
            self.assertTrue((restored / 'gradlew').stat().st_mode & 0o111)
            self.assertFalse((restored / 'local.properties').exists())
            self.assertEqual((restored / 'ci-libraries/tauri-android/build.gradle.kts').read_text(),
                             'android library')
            self.assertFalse((restored / 'ci-libraries/tauri-android/build').exists())
            self.assertIn('new File(rootDir, "ci-libraries/tauri-android")',
                          (restored / 'tauri.settings.gradle').read_text())
            self.assertNotIn(str(original), (restored / 'tauri.settings.gradle').read_text())

    def test_missing_generated_library_paths_fail_packaging(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'android'
            source.mkdir()
            (source / 'tauri.settings.gradle').write_text('// not built yet\n')
            with self.assertRaisesRegex(RuntimeError, 'No generated Tauri'):
                packaging.package_project(source, Path(temporary) / 'project.tar.gz')
