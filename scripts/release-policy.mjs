import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseVersion } from './set-release-version.mjs';

export function releasePolicy(tag) {
  const version = releaseVersion(tag);
  return {
    version,
    prerelease: version.includes('-'),
    draft: /-rc(?:\d+|\.\d+)?(?:[.-]|$)/i.test(version),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const policy = releasePolicy(process.env.RELEASE_TAG);
  for (const [key, value] of Object.entries(policy)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
