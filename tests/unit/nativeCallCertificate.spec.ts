import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('generates a short-lived localhost TLS certificate with explicit server authentication', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { X509Certificate } from 'node:crypto';
    import { createTestCertificate } from './scripts/native-calls/certificate.mjs';
    import { runCommand } from './scripts/native-calls/command.mjs';
    const directory = mkdtempSync(join(tmpdir(), 'native-cert-test-'));
    try {
      const path = createTestCertificate(directory, runCommand);
      const cert = new X509Certificate(readFileSync(path));
      assert.ok(cert.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
      assert.equal(cert.ca, false);
      assert.equal(cert.checkHost('localhost'), 'localhost');
      assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
      assert.equal(cert.checkHost('untrusted.example'), undefined);
      assert.equal(Date.parse(cert.validTo) - Date.parse(cert.validFrom), 86400000);
      assert.ok(cert.verify(cert.publicKey));
      assert.match(runCommand('openssl', ['verify', '-purpose', 'sslserver', '-CAfile', path, path]), /OK/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  `,
    ],
    { timeout: 10000 },
  );
});
