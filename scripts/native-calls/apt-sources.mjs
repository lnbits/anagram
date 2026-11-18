import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const useUbuntuArchive = (content) =>
  content.replace(
    /https?:\/\/[a-z0-9-]+\.ec2\.archive\.ubuntu\.com\/ubuntu(?=[/\s]|$)/g,
    'https://archive.ubuntu.com/ubuntu',
  );
const copy = async (relative) => {
  let content = useUbuntuArchive(await readOptional(join(source, relative)));
  // GitHub's Ubuntu images also select a mirror indirectly through this list.
  // Keep its fallback URLs, priorities and options, and leave the runner's list intact.
  const mirrorList = /mirror\+file:\/{1,3}etc\/apt\/apt-mirrors\.txt(?=\s|$)/g;
  if (content.match(mirrorList)) {
    const name = 'apt-mirrors.txt';
    const list = await readFile(join(source, name), 'utf8');
    const copied = join(destination, name);
    await writeFile(copied, useUbuntuArchive(list));
    content = content.replace(mirrorList, () => `mirror+${pathToFileURL(copied).href}`);
  }
  await writeFile(join(destination, relative), content);
};
await copy('sources.list');
const entries = await readdir(join(source, 'sources.list.d')).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
for (const name of entries) {
  if (/^[\w.-]+\.(list|sources)$/.test(name)) await copy(join('sources.list.d', name));
}
