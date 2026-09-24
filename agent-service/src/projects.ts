import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { TERMINAL_RUN_STATUSES } from '@openworkgraph/protocol';
import type { Project } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { transaction } from './persistence/database.js';
import { Repositories } from './persistence/repositories.js';

type ProjectRow = { id: string; canonical_path: string; name: string; state: Project['state']; is_git: number };

function canonicalDirectory(path: string): string {
  if (typeof path !== 'string' || path.length > 32768 || !isAbsolute(path) || path.includes('\0')) throw new ServiceError('INVALID_REQUEST', '项目路径必须是绝对目录路径。');
  try {
    const canonical = realpathSync.native(path);
    if (!statSync(canonical).isDirectory()) throw new Error('Not a directory');
    accessSync(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (cause) { throw new ServiceError('PROJECT_UNAVAILABLE', '项目目录不存在或不可访问；请修复路径，不会自动创建目录。', { cause }); }
}

function readGitFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid Git metadata file');
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 4096) throw new Error('Git metadata file too large');
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

/** Inspect Git metadata only: no processes, hooks, config execution or filesystem writes. */
function isGitDirectory(path: string): boolean {
  for (let current = path; ; current = dirname(current)) {
    try {
      const marker = join(current, '.git');
      const info = statSync(marker);
      let gitDir = marker;
      if (info.isFile()) {
        if (info.size > 4096) return false;
        const match = /^gitdir: (.+)\r?\n?$/.exec(readGitFile(marker));
        if (!match) return false;
        gitDir = resolve(current, match[1]!.trim());
      } else if (!info.isDirectory()) return false;
      let commonDir = gitDir;
      try {
        const common = join(gitDir, 'commondir');
        const value = readGitFile(common).trim();
        if (!value) return false;
        commonDir = resolve(gitDir, value);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
      return statSync(join(gitDir, 'HEAD')).isFile() && statSync(join(commonDir, 'objects')).isDirectory() && statSync(join(commonDir, 'refs')).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (dirname(current) === current) return false;
  }
}

export function inspectProjectDirectory(path: string): { canonicalPath: string; isGit: boolean } {
  const canonicalPath = canonicalDirectory(path);
  return { canonicalPath, isGit: isGitDirectory(canonicalPath) };
}

export class Projects {
  constructor(readonly db: DatabaseSync, readonly serviceId: string, readonly inspectDirectory = inspectProjectDirectory) {}

  /** Join auth.withSession; a failed operation remains atomic even if its caller catches it. */
  private atomic<T>(work: () => T): T {
    if (!this.db.isTransaction) return transaction(this.db, work);
    const savepoint = 'projects_' + randomUUID().replaceAll('-', '');
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = work(); this.db.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }

  private row(id: string): ProjectRow {
    if (typeof id !== 'string' || !id) throw new ServiceError('INVALID_REQUEST', '需要 projectId。');
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow | undefined;
    if (!row) throw new ServiceError('NOT_FOUND', '项目不存在。');
    return row;
  }

  private project(row: ProjectRow): Project {
    let availability: Project['availability'] = 'unavailable';
    try { if (this.inspectDirectory(row.canonical_path).canonicalPath === row.canonical_path) availability = 'available'; } catch (error) {
      if (error instanceof ServiceError && error.code === 'CONFLICT') throw error;
      if (!(error instanceof ServiceError) || error.code !== 'PROJECT_UNAVAILABLE') availability = 'unknown';
    }
    return { serviceId: this.serviceId, projectId: row.id, name: row.name, canonicalPath: row.canonical_path, state: row.state, availability, isGit: row.is_git === 1 };
  }

  list(state: Project['state'] | 'all' = 'active'): Project[] {
    if (!['active', 'inactive', 'all'].includes(state)) throw new ServiceError('INVALID_REQUEST', '无效的项目状态筛选。');
    return this.atomic(() => {
      const rows = this.db.prepare("SELECT * FROM projects WHERE ?='all' OR state=? ORDER BY name,id").all(state, state) as ProjectRow[];
      return rows.map(row => this.project(row));
    });
  }

  get(id: string): Project { return this.atomic(() => this.project(this.row(id))); }

  private unique(path: string, exceptId: string | null = null): void {
    const row = this.db.prepare('SELECT id FROM projects WHERE canonical_path=?').get(path);
    if (row && row['id'] !== exceptId) throw new ServiceError('CONFLICT', '此目录已注册为另一个项目；请使用已有项目。');
  }

  private noUnfinishedRuns(id: string): void {
    const placeholders = TERMINAL_RUN_STATUSES.map(() => '?').join(',');
    if (this.db.prepare(`SELECT 1 FROM runs WHERE project_id=? AND status NOT IN (${placeholders}) LIMIT 1`).get(id, ...TERMINAL_RUN_STATUSES)) {
      throw new ServiceError('ACTIVE_RUN', '项目有未结束的执行或生成任务，不能停用或修改路径。');
    }
  }

  private changed(row: ProjectRow): Project {
    const project = this.project(row);
    const revision = Number(this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM events WHERE type='project.changed' AND entity_id=?").get(row.id)!['revision']);
    new Repositories(this.db).appendEvent({ eventId: randomUUID(), type: 'project.changed', projectId: row.id, graphId: null, entityId: row.id, revision, occurredAt: new Date().toISOString(), payload: { ...project } });
    return project;
  }

  register(path: string): Project {
    return this.atomic(() => {
      const inspected = this.inspectDirectory(path);
      const canonical = inspected.canonicalPath;
      this.unique(canonical);
      const row: ProjectRow = { id: randomUUID(), canonical_path: canonical, name: basename(canonical) || canonical, state: 'active', is_git: Number(inspected.isGit) };
      this.db.prepare('INSERT INTO projects(id,canonical_path,name,state,is_git) VALUES(?,?,?,?,?)').run(row.id, row.canonical_path, row.name, row.state, row.is_git);
      return this.changed(row);
    });
  }

  setState(id: string, state: Project['state']): Project {
    if (state !== 'active' && state !== 'inactive') throw new ServiceError('INVALID_REQUEST', '项目状态必须是 active 或 inactive。');
    return this.atomic(() => {
      const row = this.row(id);
      if (row.state === state) return this.project(row);
      if (state === 'inactive') this.noUnfinishedRuns(id);
      this.db.prepare('UPDATE projects SET state=? WHERE id=?').run(state, id);
      return this.changed({ ...row, state });
    });
  }

  repairPath(id: string, path: string): Project {
    return this.atomic(() => {
      const row = this.row(id);
      if (row.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', '停用项目只读；请先启用再修复路径。');
      this.noUnfinishedRuns(id);
      const inspected = this.inspectDirectory(path);
      const canonical = inspected.canonicalPath;
      this.unique(canonical, id);
      const isGit = Number(inspected.isGit);
      if (canonical === row.canonical_path && isGit === row.is_git) return this.project(row);
      this.db.prepare('UPDATE projects SET canonical_path=?,is_git=? WHERE id=?').run(canonical, isGit, id);
      return this.changed({ ...row, canonical_path: canonical, is_git: isGit });
    });
  }

  /** Guard metadata writes; source availability is required separately for execution. */
  assertWritable(id: string): Project {
    return this.atomic(() => {
      const project = this.project(this.row(id));
      if (project.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', '停用项目只读，不能提交新任务。');
      return project;
    });
  }

  /** Future run submission must call this within its own acceptance transaction.
   * Returning a path does not lock the filesystem against subsequent external moves. */
  resolveCwd(id: string): string {
    return this.atomic(() => {
      const project = this.assertWritable(id);
      if (project.availability !== 'available') throw new ServiceError('PROJECT_UNAVAILABLE', '项目目录不可用或符号链接目标已变化；请修复项目路径。');
      return project.canonicalPath;
    });
  }
}
