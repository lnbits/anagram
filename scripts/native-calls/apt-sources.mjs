import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error('Pass the system apt directory and an output directory');
await mkdir(join(destination, 'sources.list.d'), { recursive: true });
const readOptional = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
};
// Hosted runners can inherit an EC2 regional mirror that trickles data without
// hitting apt's inactivity timeout. Use Ubuntu's archive for those URLs only;
// preserve suites, components, Signed-By, security and third-party repositories.
const copy = async (relative) => {
  const content = await readOptional(join(source, relative));
  await writeFile(
    join(destination, relative),
    content.replace(
      /https?:\/\/[a-z0-9-]+\.ec2\.archive\.ubuntu\.com\/ubuntu(?=[/\s]|$)/g,
      'https://archive.ubuntu.com/ubuntu',
    ),
  );
};
await copy('sources.list');
const entries = await readdir(join(source, 'sources.list.d')).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
for (const name of entries) {
  if (/^[\w.-]+\.(list|sources)$/.test(name)) await copy(join('sources.list.d', name));
}
