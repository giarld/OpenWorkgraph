import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceMaintenance } from '@openworkgraph/protocol';
import { atomicJson } from './files.js';
export const restoreStatePath = (root: string): string => join(root, 'restore-state.json');
export function readRestoreState(root: string): WorkspaceMaintenance {
  try {
    const path = restoreStatePath(root);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Invalid restore state file');
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceMaintenance;
    if (!['idle', 'restoring', 'completed', 'failed'].includes(value.state) || typeof value.blocked !== 'boolean') throw new Error('Invalid restore state');
    return value.state === 'restoring' ? { ...value, state: 'failed', blocked: true, message: '上次恢复未完成，工作空间已锁定，请通过本机恢复命令处理。' } : value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'idle', blocked: false };
    return { state: 'failed', blocked: true, message: '恢复状态无法读取，工作空间已锁定，请在本机检查。' };
  }
}
export const writeRestoreState = (root: string, state: WorkspaceMaintenance): Promise<void> => atomicJson(restoreStatePath(root), state);
