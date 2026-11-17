import { join } from 'node:path';

// Apple TLS policy requires an explicit server-authentication EKU.
export function createTestCertificate(directory, command) {
  const cert = join(directory, 'cert.pem');
  command(
    process.env.OPENSSL || 'openssl',
    [
      'req',
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
