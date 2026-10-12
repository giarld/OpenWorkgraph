import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Web has its own lockfile and is not installed by the root npm workspace.
const modules = new URL('../web-client/node_modules/', import.meta.url);
const required = [
  ['typescript', 'typescript/bin/tsc'],
  ['vite', 'vite/bin/vite.js'],
  ['vite/client', 'vite/client.d.ts'],
  ['@vitejs/plugin-react', '@vitejs/plugin-react/package.json'],
  ['vitest/config', 'vitest/package.json'],
];
const missing = required
  .filter(([, path]) => !existsSync(new URL(path, modules)))
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(`Web Client build dependencies are missing: ${missing.join(', ')}.`);
  console.error('Root npm ci does not install the independent web-client dependencies.');
  console.error(`Run this command from ${fileURLToPath(new URL('../', import.meta.url))}:`);
  console.error('  npm --prefix web-client ci --include=dev');
  process.exitCode = 1;
}
