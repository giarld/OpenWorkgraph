import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidSemVer } from './semver.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const manifests = await Promise.all([
  'package.json',
  'agent-service/package.json',
  'packages/protocol/package.json',
  'web-client/package.json',
].map(async path => ({ path, value: await readJson(path) })));
const expected = manifests[0].value.version;

if (!isValidSemVer(expected)) {
  throw new Error(`Workspace version is not valid SemVer: ${expected}`);
}
for (const { path, value } of manifests.slice(1)) {
  if (value.version !== expected) throw new Error(`${path} version ${value.version} does not match workspace version ${expected}`);
}

for (const path of ['package-lock.json', 'web-client/package-lock.json']) {
  const lock = await readJson(path);
  if (lock.version !== expected || lock.packages?.['']?.version !== expected) {
    throw new Error(`${path} root version does not match workspace version ${expected}`);
  }
}
const workspaceLock = await readJson('package-lock.json');
for (const path of ['agent-service', 'packages/protocol']) {
  if (workspaceLock.packages?.[path]?.version !== expected) {
    throw new Error(`package-lock.json ${path} version does not match workspace version ${expected}`);
  }
}

const protocolSource = await readFile(join(root, 'packages/protocol/src/index.ts'), 'utf8');
const serviceVersion = protocolSource.match(/export const SERVICE_VERSION = '([^']+)' as const;/)?.[1];
if (serviceVersion !== expected) {
  throw new Error(`SERVICE_VERSION ${serviceVersion ?? '<missing>'} does not match workspace version ${expected}`);
}

if (!process.argv.includes('--quiet')) console.log(`OpenWorkgraph version ${expected}`);
