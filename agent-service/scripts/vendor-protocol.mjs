import { readdir, readFile, writeFile, mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url))), dist = join(root, 'dist');
const source = join(root, '..', 'packages', 'protocol', 'dist'), target = join(dist, 'vendor', 'protocol');
const testDirectories = new Set(['test', 'tests', '__tests__', 'fixtures', 'example', 'examples']);
const excluded = entry => testDirectories.has(entry.name) || /\.(test|spec|typecheck)\./.test(entry.name);
// Incremental builds reuse dist. Remove prior test copies as well as preventing
// new ones, so fixing the filter also repairs an already-built package.
async function pruneTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (excluded(entry)) await rm(path, { recursive: true, force: true });
    else if (entry.isDirectory()) await pruneTests(path);
  }
}
async function copy(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (excluded(entry)) continue;
    if (entry.isDirectory()) await copy(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile() && !entry.name.endsWith('.map')) await copyFile(join(from, entry.name), join(to, entry.name));
  }
}
await mkdir(target, { recursive: true });
await pruneTests(target);
await copy(source, target);
async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor') await rewrite(path); continue; }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) continue;
    let specifier = relative(dirname(path), join(target, 'index.js')).replaceAll('\\', '/');
    if (!specifier.startsWith('.')) specifier = './' + specifier;
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replaceAll("'@openworkgraph/protocol'", JSON.stringify(specifier)).replaceAll('"@openworkgraph/protocol"', JSON.stringify(specifier)));
  }
}
await rewrite(dist);
// TypeScript creates a fresh CLI file without executable permissions.
// Workspace bin links execute this file directly, so every build must restore them.
await chmod(join(dist, 'cli.js'), 0o755);
