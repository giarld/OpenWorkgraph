import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentError } from '../errors.js';
import type { OpenCodeShellProcessEvidence } from './process-evidence.js';

export interface OpenCodeJournalIdentity { runId: string; attemptId: string; instanceId: string }
export type OpenCodeActionKind = 'session' | 'shell' | 'skill' | 'host_tool' | 'mcp' | 'plugin' | 'pty' | 'process';
export type OpenCodeActionPhase = 'pending' | 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled';
export interface OpenCodeAction {
  kind: OpenCodeActionKind; id: string; sessionId: string | null; parentId: string | null;
  phase: OpenCodeActionPhase; pid: number | null; exitCode: number | null;
}
const kinds = new Set<OpenCodeActionKind>(['session', 'shell', 'skill', 'host_tool', 'mcp', 'plugin', 'pty', 'process']);
const terminal = new Set<OpenCodeActionPhase>(['completed', 'failed', 'cancelled']);
function identifier(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new AgentError('invalid_configuration');
}
/** Host-private durable native facts, not a second Run state machine. A new
 * native service's empty action lists provide NO evidence for an old instance.
 * No prompt, output, environment, credentials or command is stored here. */
export class OpenCodeActionJournal {
  private readonly db: DatabaseSync;
  readonly identity: Readonly<OpenCodeJournalIdentity>;
  constructor(directory: string, identity: OpenCodeJournalIdentity) {
    for (const value of [identity.runId, identity.attemptId, identity.instanceId]) identifier(value);
    this.identity = Object.freeze({ runId: identity.runId, attemptId: identity.attemptId, instanceId: identity.instanceId });
    const path = join(directory, 'workgraph-native.sqlite');
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS native_binding (kind TEXT NOT NULL, id TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY (kind, id));');
      this.db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, instance_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS action (kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, parent_id TEXT, phase TEXT NOT NULL, pid INTEGER, exit_code INTEGER, PRIMARY KEY (kind, id));
        CREATE TABLE IF NOT EXISTS shell_process (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, group_id INTEGER NOT NULL, started TEXT NOT NULL);`);
      this.db.prepare('INSERT OR IGNORE INTO owner VALUES (1, ?, ?, ?)').run(identity.runId, identity.attemptId, identity.instanceId);
      const owner = this.db.prepare('SELECT run_id, attempt_id, instance_id FROM owner WHERE singleton = 1').get();
      if (!owner || owner.run_id !== identity.runId || owner.attempt_id !== identity.attemptId || owner.instance_id !== identity.instanceId) throw new AgentError('outcome_unknown');
    } catch (error) { this.db.close(); throw error; }
  }
  list(): OpenCodeAction[] {
    return this.db.prepare('SELECT kind, id, session_id AS sessionId, parent_id AS parentId, phase, pid, exit_code AS exitCode FROM action ORDER BY kind, id').all() as unknown as OpenCodeAction[];
  }
  get unresolved(): boolean {
    return !!this.db.prepare("SELECT 1 FROM action WHERE phase NOT IN ('completed', 'failed', 'cancelled') LIMIT 1").get();
  }
  /** Shell.create can be interrupted while its detached native spawn fiber is
   * still settling. Only its explicitly linked process exit/failure can close
   * an unbound shell; idle sessions or an empty native list are insufficient. */
  settleUnboundShells(): void {
    const actions = this.list();
    for (const shell of actions.filter(action => action.kind === 'shell' && action.phase === 'unknown' && action.pid === null && !this.nativeId('shell', action.id))) {
      const processes = actions.filter(action => action.kind === 'process' && action.parentId === shell.id);
      if (!processes.length || processes.some(action => !terminal.has(action.phase))) continue;
      this.observe(this.identity.instanceId, 'shell', shell.id, processes.some(action => action.phase === 'cancelled') ? 'cancelled' : 'failed');
    }
  }
  bindNative(kind: OpenCodeActionKind, id: string, nativeId: string, pid?: number): void {
    identifier(nativeId);
    const previous = this.nativeId(kind, id);
    if (previous && previous !== nativeId) throw new AgentError('outcome_unknown');
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new AgentError('protocol_error');
    const action = this.db.prepare('SELECT pid FROM action WHERE kind = ? AND id = ?').get(kind, id);
    if (!action || action.pid !== null && action.pid !== (pid ?? null)) throw new AgentError('outcome_unknown');
    this.db.prepare('INSERT OR IGNORE INTO native_binding VALUES (?, ?, ?)').run(kind, id, nativeId);
    if (pid !== undefined) this.db.prepare('UPDATE action SET pid = ? WHERE kind = ? AND id = ? AND pid IS NULL').run(pid, kind, id);
  }
  nativeId(kind: OpenCodeActionKind, id: string): string | null {
    const row = this.db.prepare('SELECT native_id FROM native_binding WHERE kind = ? AND id = ?').get(kind, id);
    return row ? String(row.native_id) : null;
  }
  /** Reserve BEFORE a dispatch whenever the native API accepts caller IDs.
   * Observed background work must be recorded before considering parent exit. */
  register(action: Pick<OpenCodeAction, 'kind' | 'id'> & Partial<Pick<OpenCodeAction, 'sessionId' | 'parentId' | 'pid'>>): void {
    if (!kinds.has(action.kind)) throw new AgentError('invalid_configuration');
    identifier(action.id);
    if (action.sessionId != null) identifier(action.sessionId);
    if (action.parentId != null) identifier(action.parentId);
    if (action.pid != null && (!Number.isSafeInteger(action.pid) || action.pid <= 0)) throw new AgentError('invalid_configuration');
    const previous = this.db.prepare('SELECT * FROM action WHERE kind = ? AND id = ?').get(action.kind, action.id);
    if (previous) {
      if (previous.session_id !== (action.sessionId ?? null) || previous.parent_id !== (action.parentId ?? null) || previous.pid !== (action.pid ?? null)) throw new AgentError('protocol_error');
      return;
    }
    this.db.prepare('INSERT INTO action VALUES (?, ?, ?, ?, ?, ?, NULL)').run(action.kind, action.id, action.sessionId ?? null, action.parentId ?? null, 'pending', action.pid ?? null);
  }
  observe(instanceId: string, kind: OpenCodeActionKind, id: string, phase: Exclude<OpenCodeActionPhase, 'pending'>, exitCode: number | null = null): void {
    if (instanceId !== this.identity.instanceId || !kinds.has(kind) || !['running', 'unknown', 'completed', 'failed', 'cancelled'].includes(phase) || exitCode !== null && !Number.isSafeInteger(exitCode)) throw new AgentError('protocol_error');
    const row = this.db.prepare('SELECT phase, exit_code FROM action WHERE kind = ? AND id = ?').get(kind, id);
    if (!row) throw new AgentError('outcome_unknown');
    if (terminal.has(row.phase as OpenCodeActionPhase)) {
      if (row.phase !== phase || row.exit_code !== exitCode) throw new AgentError('protocol_error');
      return;
    }
    this.db.prepare('UPDATE action SET phase = ?, exit_code = ? WHERE kind = ? AND id = ?').run(phase, exitCode, kind, id);
  }
  /** Transport/process loss and cancel ACK never manufacture exit evidence. */
  disconnected(): void { this.db.exec("UPDATE action SET phase = 'unknown' WHERE phase IN ('pending', 'running')"); }
  rememberShellProcess(id: string, evidence: OpenCodeShellProcessEvidence): void {
    this.rememberProcess('shell', id, evidence);
  }
  rememberProcess(kind: OpenCodeActionKind, id: string, evidence: OpenCodeShellProcessEvidence): void {
    if (evidence.instanceId !== this.identity.instanceId || evidence.pid !== evidence.groupId || !Number.isSafeInteger(evidence.pid) || evidence.pid <= 1 || typeof evidence.started !== 'string' || !evidence.started || evidence.started.length > 128) throw new AgentError('protocol_error');
    const action = this.db.prepare('SELECT pid FROM action WHERE kind = ? AND id = ?').get(kind, id);
    if (!action || action.pid !== evidence.pid) throw new AgentError('protocol_error');
    const previous = this.shellProcess(id);
    if (previous) { if (previous.pid !== evidence.pid || previous.groupId !== evidence.groupId || previous.started !== evidence.started) throw new AgentError('protocol_error'); return; }
    this.db.prepare('INSERT INTO shell_process VALUES (?, ?, ?, ?)').run(id, evidence.pid, evidence.groupId, evidence.started);
  }
  shellProcess(id: string): OpenCodeShellProcessEvidence | null {
    const row = this.db.prepare('SELECT pid, group_id, started FROM shell_process WHERE id = ?').get(id);
    return row ? { instanceId: this.identity.instanceId, pid: Number(row.pid), groupId: Number(row.group_id), started: String(row.started) } : null;
  }
  assertDrained(): void { if (this.unresolved) throw new AgentError('outcome_unknown'); }
  /** Explicit continuation is the only transition out of a recorded session
   * terminal. It requires the entire previous busy period to have drained. */
  beginContinuation(id: string): void {
    this.assertDrained();
    const row = this.db.prepare("SELECT phase FROM action WHERE kind='session' AND id=?").get(id);
    if (!row || !terminal.has(row.phase as OpenCodeActionPhase)) throw new AgentError('outcome_unknown');
    this.db.prepare("UPDATE action SET phase='running',exit_code=NULL WHERE kind='session' AND id=?").run(id);
  }
  confirmStopped(revision: string): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS manual_resolution(revision TEXT PRIMARY KEY,time TEXT NOT NULL); BEGIN IMMEDIATE;');
    try {
      this.db.prepare('INSERT OR IGNORE INTO manual_resolution VALUES(?,?)').run(revision, new Date().toISOString());
      this.db.exec("UPDATE action SET phase='failed',exit_code=NULL WHERE phase NOT IN ('completed','failed','cancelled'); COMMIT;");
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  close(): void { this.db.close(); }
}
