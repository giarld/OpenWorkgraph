import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ServiceError } from './errors.js';
export interface DataDirectories { root: string; database: string; config: string; blobs: string; staging: string; runs: string; backups: string }
function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServiceError('INVALID_REQUEST', 'Service directories must be real directories, not symlinks');
  return realpathSync(path);
}
export function initializeDirectories(path = join(homedir(), '.openworkgraph')): DataDirectories {
  const root = privateDirectory(resolve(path));
  const result = { root, database: join(root, 'service.sqlite'), config: privateDirectory(join(root,'config')), blobs: privateDirectory(join(root,'blobs')), staging: privateDirectory(join(root,'staging')), runs: privateDirectory(join(root,'runs')), backups: privateDirectory(join(root,'backups')) };
  for (const file of [result.database, result.database + '-wal', result.database + '-shm']) {
    try { if (lstatSync(file).isSymbolicLink()) throw new ServiceError('INVALID_REQUEST', 'Database files cannot be symlinks'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}
export function runDirectories(directories: DataDirectories, runId: string): { input: string; output: string } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) throw new ServiceError('INVALID_REQUEST', 'Invalid Run identifier');
  const runs = privateDirectory(directories.runs);
  const root = privateDirectory(join(runs,runId));
  return { input: privateDirectory(join(root,'input')), output: privateDirectory(join(root,'output')) };
}
