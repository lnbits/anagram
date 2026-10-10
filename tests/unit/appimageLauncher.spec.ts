import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('launches the AppImage from its own usr directory with packaged hooks and display defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anagram launcher '));
  try {
    mkdirSync(join(dir, 'usr/bin'), { recursive: true });
    mkdirSync(join(dir, 'apprun-hooks'));
    copyFileSync(resolve('scripts/appimage/AppRun'), join(dir, 'AppRun'));
    writeFileSync(
      join(dir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh'),
      'export GDK_BACKEND=wayland\nexport GTK_DATA_PREFIX="$APPDIR"\n',
    );
    writeFileSync(
      join(dir, 'apprun-hooks/linuxdeploy-plugin-gstreamer.sh'),
      'export GST_PLUGIN_SYSTEM_PATH_1_0="$APPDIR/usr/lib/gstreamer-1.0"\n',
    );
    writeFileSync(
      join(dir, 'usr/bin/anagram'),
      `#!/usr/bin/env node
console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),env:Object.fromEntries(['APPDIR','GDK_BACKEND','GTK_DATA_PREFIX','GST_PLUGIN_SYSTEM_PATH_1_0','LD_LIBRARY_PATH'].map(key=>[key,process.env[key]]))}));
`,
      { mode: 0o755 },
    );
    const result = JSON.parse(
      execFileSync('bash', [join(dir, 'AppRun'), 'argument with spaces'], {
        cwd: tmpdir(),
        env: { ...process.env, APPDIR: '/stale-appdir', GDK_BACKEND: 'wayland' },
        encoding: 'utf8',
      }),
    );
    expect(result.cwd).toBe(join(dir, 'usr'));
    expect(result.args).toEqual(['argument with spaces']);
    expect(result.env.APPDIR).toBe(dir);
    expect(result.env.GDK_BACKEND).toBe('x11,wayland');
    expect(result.env.GTK_DATA_PREFIX).toBe(dir);
    expect(result.env.GST_PLUGIN_SYSTEM_PATH_1_0).toBe(join(dir, 'usr/lib/gstreamer-1.0'));
    expect(result.env.LD_LIBRARY_PATH.split(':').slice(0, 2)).toEqual([
      join(dir, 'usr/lib'),
      join(dir, 'usr/lib/x86_64-linux-gnu'),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
