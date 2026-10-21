import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Development-only prepack. Installed tarballs need no source workspace or
// build tools; the packaged postinstall only repairs optional SDK dependencies.
for (const cwd of [join(root, '..', 'packages', 'protocol'), root]) {
  const packageRoot = resolve(cwd);
  const output = resolve(packageRoot, 'dist');
  if (dirname(output) !== packageRoot) throw new Error(`Unsafe build output path: ${output}`);
  await rm(output, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Keep published documentation identical to the repository's maintained copies.
for (const name of ['README.md', 'README.zh-CN.md']) {
  await copyFile(join(root, '..', name), join(root, name));
}
const readmeAssets = join(root, 'assets', 'readme');
await rm(readmeAssets, { recursive: true, force: true });
await mkdir(dirname(readmeAssets), { recursive: true });
await cp(join(root, '..', 'assets', 'readme'), readmeAssets, { recursive: true });
