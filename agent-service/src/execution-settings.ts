import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionSettings, SandboxMode } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

export function sandboxMode(value: unknown): SandboxMode {
  if (value !== 'read-only' && value !== 'workspace-write' && value !== 'danger-full-access') throw new ServiceError('INVALID_REQUEST', '请选择有效的沙盒权限范围。');
  return value;
}

/** Runtime-local settings, persisted with CAS. Codex enforces their permissions. */
export class ExecutionSettingsStore {
  constructor(private readonly db: DatabaseSync) {}
  get(): ExecutionSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='executionSettings'").get();
    if (!row) return { revision: 0, sandboxMode: 'workspace-write' };
    const value = JSON.parse(String(row.value));
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new ServiceError('MAINTENANCE', '运行时权限设置损坏。');
    return { revision: value.revision, sandboxMode: sandboxMode(value.sandboxMode) };
  }
  set(mode: unknown, expectedRevision: unknown): ExecutionSettings {
    const selected = sandboxMode(mode);
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0 || (expectedRevision as number) >= Number.MAX_SAFE_INTEGER) throw new ServiceError('INVALID_REQUEST', '权限设置修订号无效。');
    const current = this.get();
    if (current.revision !== expectedRevision) throw new ServiceError('REVISION_CONFLICT', '权限设置已变化，请刷新后重试。');
    const next = { revision: current.revision + 1, sandboxMode: selected };
    const result = current.revision === 0
      ? this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('executionSettings',?)").run(JSON.stringify(next))
      : this.db.prepare("UPDATE settings SET value=? WHERE key='executionSettings' AND json_extract(value,'$.revision')=?").run(JSON.stringify(next), current.revision);
    if (result.changes !== 1) throw new ServiceError('REVISION_CONFLICT', '权限设置已变化，请刷新后重试。');
    return next;
  }
}
