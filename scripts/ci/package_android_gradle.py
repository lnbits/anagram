"""Package the built Android Gradle project for independent JVM/harness jobs."""
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile


def package_project(source, destination):
    # Do not carry Gradle caches or build outputs between runners. Dereference
    # JNI symlinks so the harness keeps the native libraries from the APK build.
    ignored = shutil.ignore_patterns('build', '.gradle', '.kotlin', '.cxx', 'local.properties')
    with tempfile.TemporaryDirectory() as temporary:
        project = Path(temporary) / 'android'
        shutil.copytree(source, project, ignore=ignored)
        settings = project / 'tauri.settings.gradle'

        def vendor_library(match):
            name = match['name']
            library = Path(json.loads(match['path']))
            shutil.copytree(library, project / 'ci-libraries' / name, ignore=ignored)
            return f"project(':{name}').projectDir = new File(rootDir, \"ci-libraries/{name}\")"

        # Tauri generates absolute Cargo registry paths during the native build.
        # Bundle those exact Android sources and make their paths portable.
        contents, count = re.subn(
            r"project\(':(?P<name>[\w-]+)'\)\.projectDir = new File\((?P<path>\"[^\"]+\")\)",
            vendor_library,
            settings.read_text(),
        )
        if count == 0:
            raise RuntimeError('No generated Tauri Android libraries found')
        settings.write_text(contents)
        with tarfile.open(destination, 'w:gz') as archive:
            archive.add(project, arcname='android')


if __name__ == '__main__':
    package_project(Path('src-tauri/gen/android'), Path(sys.argv[1]))
