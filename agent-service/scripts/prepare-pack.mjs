import { spawnSync } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Development-only prepack. Installed tarballs contain no build/install scripts
// or unpublished dependencies, and never need the source workspace.
for (const cwd of [join(root, '..', 'packages', 'protocol'), root]) {
  const packageRoot = resolve(cwd);
  const output = resolve(packageRoot, 'dist');
  if (dirname(output) !== packageRoot) throw new Error(`Unsafe build output path: ${output}`);
  await rm(output, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Keep the published README identical to the repository's maintained copy.
await copyFile(join(root, '..', 'README.md'), join(root, 'README.md'));
