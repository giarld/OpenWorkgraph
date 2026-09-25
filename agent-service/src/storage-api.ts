import type { IncomingMessage } from 'node:http';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ApiResult } from './api.js';
import { Auth } from './auth.js';
import type { DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { readJson } from './http.js';
import { transaction } from './persistence/database.js';
import { Resources } from './resources.js';

export interface StorageUsage {
  totalBytes: number;
  categories: Record<'database' | 'resources' | 'runs' | 'backups' | 'config' | 'staging' | 'other', number>;
  measuredAt: string;
}

const category = (name: string): keyof StorageUsage['categories'] => {
  if (name === 'service.sqlite' || name.startsWith('service.sqlite-')) return 'database';
  if (name === 'blobs') return 'resources';
  if (name === 'runs') return 'runs';
  if (name === 'backups') return 'backups';
  if (name === 'config') return 'config';
  if (name === 'staging') return 'staging';
  return 'other';
};

/** Count managed files below the Runtime data root; never follow symlinks. */
export async function measureStorage(directories: DataDirectories): Promise<StorageUsage> {
  const categories: StorageUsage['categories'] = { database: 0, resources: 0, runs: 0, backups: 0, config: 0, staging: 0, other: 0 };
  const pending: Array<{ path: string; category: keyof StorageUsage['categories'] }> = [{ path: directories.root, category: 'other' }];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory.path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory.path !== directories.root) continue; throw error; }
    for (const entry of entries) {
      const path = join(directory.path, entry.name);
      const group = directory.path === directories.root ? category(entry.name) : directory.category;
      let info;
      try { info = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) pending.push({ path, category: group });
      else if (info.isFile()) categories[group] += info.size;
    }
  }
  return { totalBytes: Object.values(categories).reduce((sum, bytes) => sum + bytes, 0), categories, measuredAt: new Date().toISOString() };
}

export class StorageApi {
  constructor(readonly db: DatabaseSync, readonly directories: DataDirectories, readonly resources: Resources, readonly auth: Auth) {}

  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    if (path !== '/v1/storage' && path !== '/v1/storage/cleanup') return { handled: false };
    this.auth.withSession(token, origin, () => undefined);
    if (path === '/v1/storage' && request.method === 'GET') {
      const usage = await measureStorage(this.directories);
      return this.auth.withSession(token, origin, () => ({ handled: true, body: usage }));
    }
    if (path === '/v1/storage/cleanup' && request.method === 'POST') {
      const body = await readJson(request, 1024);
      if (Object.keys(body).length) throw new ServiceError('INVALID_REQUEST', '缓存清理不接受额外参数。');
      this.auth.withSession(token, origin, () => undefined);
      const collected = transaction(this.db, () => this.resources.collectGarbage(undefined, true));
      const deletion = await this.resources.drainFileDeletions();
      const usage = await measureStorage(this.directories);
      return this.auth.withSession(token, origin, () => ({ handled: true, body: { collectedResources: collected.canvas, collectedBlobs: collected.blobs, removedFiles: deletion.removed, failedFiles: deletion.failed, usage } }));
    }
    throw new ServiceError('NOT_FOUND', '存储数据接口不存在。');
  }
}
