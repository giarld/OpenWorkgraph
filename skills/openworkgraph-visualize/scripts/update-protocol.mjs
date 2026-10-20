#!/usr/bin/env node
// Maintenance only; generated runtime has no npm dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

if (process.argv.length !== 3) throw new Error('Usage: node update-protocol.mjs REPOSITORY');
const NL = String.fromCharCode(10);
const repo = resolve(process.argv[2]);
const requireFromRepo = createRequire(resolve(repo, 'package.json'));
const { build } = requireFromRepo('esbuild');
const product = JSON.parse(await readFile(resolve(repo, 'package.json'), 'utf8'));
const output = resolve(dirname(fileURLToPath(import.meta.url)), 'vendor');
const result = await build({
  absWorkingDir: repo, bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24',
  treeShaking: true, legalComments: 'none', metafile: true,
  stdin: { resolveDir: repo, sourcefile: 'owgv-skill-entry.mjs', contents: [
    'export { buildVisualizeAssetPackage, buildVisualizeToolTemplate, validateVisualizeAssetPackageBytes, readVisualizeAssetPage } from "./packages/protocol/src/visualize-library.ts";',
    'export { validateVisualizePagePackage } from "./packages/protocol/src/visualize-validation.ts";',
    'export { collectVisualizeAssetReferences } from "./packages/protocol/src/visualize-assets.ts";',
  ].join(NL) },
});
const digest = createHash('sha256');
for (const input of Object.keys(result.metafile.inputs).filter(input => input !== 'owgv-skill-entry.mjs').sort()) {
  const path = resolve(repo, input);
  digest.update(relative(repo, path).split(String.fromCharCode(92)).join('/'));
  digest.update(await readFile(path));
}
const header = ['// Generated from OpenWorkgraph ' + product.version + '; MIT, Copyright (c) 2026 Gxin.',
  '// Protocol source SHA-256: ' + digest.digest('hex'),
  '// Rebuild using ../update-protocol.mjs; see LICENSE.txt. Do not edit.', ''].join(NL);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'protocol.mjs'), header + result.outputFiles[0].text, 'utf8');
await writeFile(resolve(output, 'LICENSE.txt'), await readFile(resolve(repo, 'LICENSE'), 'utf8'), 'utf8');
console.log(JSON.stringify({ path: output, productVersion: product.version, bytes: Buffer.byteLength(header + result.outputFiles[0].text) }));
