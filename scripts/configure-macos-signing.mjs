import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function environment(name, value) {
  const delimiter = `ANAGRAM_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_ENV, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
const certificate = process.env.APPLE_CERTIFICATE;
if (!certificate) {
  environment('APPLE_SIGNING_IDENTITY', '-');
} else {
  if (!process.env.APPLE_CERTIFICATE_PASSWORD)
    throw new Error('Missing Apple certificate password');
  let identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    // Extract only the public certificate to discover the existing Developer ID
    // identity; never extract or print its private key or password.
    const args = ['pkcs12', '-nokeys', '-clcerts', '-passin', 'env:APPLE_CERTIFICATE_PASSWORD'];
    const options = { input: Buffer.from(certificate, 'base64'), stdio: ['pipe', 'pipe', 'pipe'] };
    let pem;
    try {
      pem = execFileSync('openssl', args, options);
    } catch {
      // Older Keychain exports may use RC2, disabled by OpenSSL 3 by default.
      pem = execFileSync('openssl', [...args, '-legacy'], options);
    }
    const subject = execFileSync(
      'openssl',
      ['x509', '-noout', '-subject', '-nameopt', 'multiline'],
      { input: pem, encoding: 'utf8' },
    );
    identity = subject.match(/commonName\s*=\s*(.+)/)?.[1].trim();
    if (!identity?.startsWith('Developer ID Application:'))
      throw new Error('Expected a macOS Developer ID Application certificate');
  }
  environment('APPLE_CERTIFICATE', certificate);
  environment('APPLE_CERTIFICATE_PASSWORD', process.env.APPLE_CERTIFICATE_PASSWORD);
  environment('APPLE_SIGNING_IDENTITY', identity);
  const names = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  if (names.some((name) => process.env[name]) && !names.every((name) => process.env[name]))
    throw new Error(
      'Notarization requires APPLE_ID, APPLE_PASSWORD (or APPLE_APP_SPECIFIC_PASSWORD) and APPLE_TEAM_ID',
    );
  for (const name of names) if (process.env[name]) environment(name, process.env[name]);
}
