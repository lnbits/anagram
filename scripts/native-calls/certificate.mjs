import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

// Apple TLS policy requires an explicit server-authentication EKU.
export function createTestCertificate(directory, command) {
  const cert = join(directory, 'cert.pem');
  // Runner OpenSSL configurations can inject their own X.509 extensions.
  // Older OpenSSL versions append -addext values, producing duplicate OIDs
  // which macOS rejects. Keep all certificate extensions explicit below.
  const config = join(directory, 'openssl.cnf');
  writeFileSync(config, '[req]\ndistinguished_name=dn\n[dn]\n');
  command(
    process.env.OPENSSL || 'openssl',
    [
      'req',
      '-config',
      config,
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=Anagram disposable call test',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  return cert;
}
