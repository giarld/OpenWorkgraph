import { DatabaseSync } from 'node:sqlite';
import { replaceDatabase } from './replace-database.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupRestoreChallenge, WorkspaceMaintenance } from '@openworkgraph/protocol';
import { TERMINAL_RUN_STATUSES } from '@openworkgraph/protocol';
import { Backups, waitForBackups } from './backups.js';
import type { OperationsLock } from './lifecycle.js';
import type { DataDirectories } from '../directories.js';
import { ServiceError } from '../errors.js';
import { errorLogFields, type Logger } from '../logger.js';
import { createDatabaseSnapshot } from './snapshot.js';
import { readRestoreState, writeRestoreState } from './restore-state.js';

interface Challenge { preview: BackupRestoreChallenge; principal: string; origin: string; tokenHash: string; expires: number; accepted?: { key: string; operationId: string } }
interface RestoreHooks { quiesce(): Promise<void>; reload(): Promise<void>; discardPrepared(): void; resume(): void; canStart(): boolean }
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export class WorkspaceRestore {
  private state: WorkspaceMaintenance;
  private readonly challenges = new Map<string, Challenge>();
  private work: Promise<void> = Promise.resolve();
  constructor(private readonly db: DatabaseSync, private readonly directories: DataDirectories, private readonly lock: OperationsLock | undefined, private readonly logger: Logger, private readonly backups: () => Backups, private readonly hooks: RestoreHooks) {
    const previous = readRestoreState(directories.root);
    // Completion is reported to observers of this process; a new process starts idle.
    this.state = previous.state === 'completed' && !previous.blocked ? { state: 'idle', blocked: false } : previous;
  }
  get status(): WorkspaceMaintenance { return { ...this.state }; }
  settled(): Promise<void> { return this.work; }
  async runtimeFailed(error: unknown): Promise<void> {
    this.logger.write('error', 'restore.runtime_failed', errorLogFields(error));
    this.state = { ...this.state, state: 'failed', blocked: true, message: '恢复后的工作空间未能启动，请检查本机日志并恢复。' };
    await writeRestoreState(this.directories.root, this.state).catch(failure => this.logger.write('error', 'restore.state_failed', errorLogFields(failure)));
  }
  requireAvailable(): void { if (this.state.blocked) throw new ServiceError('MAINTENANCE', this.state.message ?? '工作空间正在恢复备份，暂时禁止所有操作。', { details: { workspaceMaintenance: { ...this.status } } }); }
  private requireIdle(): void {
    this.requireAvailable();
    if (!this.lock?.held || !this.hooks.canStart() || this.db.prepare("SELECT value FROM settings WHERE key='acceptingRuns'").get()?.value !== 'true' ) throw new ServiceError('CONFLICT', '工作空间当前不能恢复，请通过管理命令启动并等待其他维护操作结束。');
    if (this.db.prepare('SELECT 1 FROM runs WHERE status NOT IN (' + TERMINAL_RUN_STATUSES.map(() => '?').join(',') + ') LIMIT 1').get(...TERMINAL_RUN_STATUSES)) throw new ServiceError('ACTIVE_RUN', '存在未结束的任务，请先结束任务后再恢复备份。');
  }
  async preview(id: string, principal: string, token: string, origin: string): Promise<BackupRestoreChallenge> {
    this.requireIdle();
    const row = (await this.backups().list()).find(item => item.id === id);
    if (!row || row.state !== 'ready') throw new ServiceError('NOT_FOUND', '备份不存在或尚未就绪。');
    const preview = await this.backups().previewRestore(join(this.directories.backups, id));
    this.requireIdle();
    const expires = Date.now() + 5 * 60_000, confirmationToken = randomBytes(32).toString('base64url');
    for (const [key, value] of this.challenges) if (value.expires <= Date.now()) this.challenges.delete(key);
    const result = { ...preview, confirmationToken, expiresAt: new Date(expires).toISOString() };
    this.challenges.set(confirmationToken, { preview: result, principal, origin, tokenHash: hashToken(token), expires });
    return result;
  }
  start(id: string, body: Record<string, unknown>, principal: string | undefined, token: string, origin: string): WorkspaceMaintenance {
    if (Object.keys(body).some(key => !['confirmationToken', 'confirmationText', 'idempotencyKey'].includes(key))) throw new ServiceError('INVALID_REQUEST', '恢复请求包含未知字段。');
    const challenge = typeof body.confirmationToken === 'string' ? this.challenges.get(body.confirmationToken) : undefined;
    if (!challenge || challenge.origin !== origin || challenge.tokenHash !== hashToken(token) || (principal !== undefined && challenge.principal !== principal) || challenge.preview.backupId !== id || body.confirmationText !== 'RESTORE' || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey || body.idempotencyKey.length > 128) throw new ServiceError('INVALID_REQUEST', '恢复确认无效，请重新检查备份并输入 RESTORE。');
    if (challenge.accepted) {
      if (challenge.accepted.key !== body.idempotencyKey) throw new ServiceError('IDEMPOTENCY_CONFLICT', '恢复确认已用于其他请求。');
      return this.status;
    }
    this.requireIdle();
    if (challenge.expires <= Date.now()) throw new ServiceError('CONFLICT', '恢复确认已过期，请重新检查备份。');
    const row = this.db.prepare('SELECT state,sha256 FROM backups WHERE id=?').get(id);
    if (row?.state !== 'ready' || row.sha256 !== challenge.preview.sha256) throw new ServiceError('CONFLICT', '备份已变化，请重新检查。');
    const operationId = randomUUID(); challenge.accepted = { key: body.idempotencyKey, operationId };
    this.state = { state: 'restoring', blocked: true, operationId, backupId: id, phase: 'draining' };
    this.work = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.perform(challenge));
    void this.work.catch(error => this.logger.write('error', 'restore.failed', errorLogFields(error)));
    return this.status;
  }
  private async phase(phase: NonNullable<WorkspaceMaintenance['phase']>): Promise<void> { this.state = { ...this.state, phase }; await writeRestoreState(this.directories.root, this.state); }
  private async perform(challenge: Challenge): Promise<void> {
    let directory: string | undefined, rollback: string | undefined, applying = false;
    try {
      await this.phase('draining'); await this.hooks.quiesce(); await waitForBackups(this.db);
      directory = await mkdtemp(join(await realpath(tmpdir()), 'workgraph-restore-rollback-')); rollback = join(directory, 'service.sqlite');
      await createDatabaseSnapshot(this.directories.database, rollback);
      await this.phase('verifying');
      const local = new Backups(this.db, this.directories, { maintenance: this.lock!, logger: this.logger });
      const path = join(this.directories.backups, challenge.preview.backupId), checked = await local.previewRestore(path);
      if (checked.sha256 !== challenge.preview.sha256) throw new ServiceError('CONFLICT', '备份内容已变化，已取消恢复。');
      await this.phase('restoring'); applying = true; await local.restore(path, checked.sha256);
      await this.phase('restarting'); await this.hooks.reload();
      const completed: WorkspaceMaintenance = { state: 'completed', blocked: false, operationId: this.state.operationId!, backupId: challenge.preview.backupId, message: '备份恢复完成，请重新配对工作空间。' };
      await writeRestoreState(this.directories.root, completed);
      this.state = completed;
      this.hooks.resume();
      this.logger.write('info', 'service.restored', { backupId: challenge.preview.backupId });
    } catch (error) {
      this.logger.write('error', 'restore.failed', { ...(this.state.phase ? { stage: this.state.phase } : {}), ...errorLogFields(error) });
      let blocked = false;
      try {
        if (applying && rollback) {
          this.hooks.discardPrepared();
          await this.phase('rollback'); const source = new DatabaseSync(rollback, { readOnly: true, allowExtension: false });
          try { await replaceDatabase(this.db, this.directories.database, source); } finally { source.close(); }
          if (Number(this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy) !== 0) throw new Error('Rollback WAL checkpoint failed');
        }
        await this.hooks.reload();
      } catch (rollbackError) { blocked = true; this.logger.write('error', 'restore.rollback_failed', errorLogFields(rollbackError)); }
      const failed: WorkspaceMaintenance = { state: 'failed', blocked, ...(this.state.operationId ? { operationId: this.state.operationId } : {}), message: blocked ? '恢复失败，工作空间已锁定，请在本机检查并恢复。' : '恢复失败，当前数据已保留，请检查工作空间日志后重试。' };
      try { await writeRestoreState(this.directories.root, failed); this.state = failed; if (!blocked) this.hooks.resume(); }
      catch (stateError) { this.state = { ...failed, blocked: true }; this.logger.write('error', 'restore.state_failed', errorLogFields(stateError)); }
    } finally {
      if (directory && !this.state.blocked) await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(error => this.logger.write('warn', 'restore.cleanup_failed', errorLogFields(error)));
    }
  }
}
