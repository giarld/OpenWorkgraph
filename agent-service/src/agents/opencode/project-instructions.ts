import { createHash } from 'node:crypto';
import { chmodSync, constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentError } from '../errors.js';
import type { OpenCodeInstanceIdentity } from './instance.js';
import type { OpenCodeTransport } from './transport.js';

const maximumValueBytes = 256 * 1024;
const key = 'workgraph.project';
interface Source { path: string; content: string; sha256: string }
interface Frozen { sources: Source[]; value: string; revision: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const contains = (parent: string, child: string) => { const path = relative(parent, child); return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
function frozen(sources: Source[]): Frozen {
  const value = sources.map(source => 'Instructions from: ' + source.path + '\n' + source.content).join('\n\n');
  // Native InstructionEntry limits JSON-encoded bytes, including escaping.
  if (Buffer.byteLength(JSON.stringify(value)) > maximumValueBytes) throw new AgentError('invalid_configuration');
  return { sources, value, revision: hash(JSON.stringify(sources.map(({ path, sha256 }) => ({ path, sha256 })))) };
}
async function readSource(path: string): Promise<Source | undefined> {
  let file;
  try {
    path = await realpath(path);
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumValueBytes) throw new AgentError('invalid_configuration');
    const buffer = Buffer.alloc(maximumValueBytes + 1);
    let size = 0;
    while (size < buffer.length) { const part = await file.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > maximumValueBytes) throw new AgentError('invalid_configuration');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    return { path, content, sha256: hash(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AgentError('invalid_configuration');
  } finally { await file?.close(); }
}
/** Extra owning-project context for a Run outside the project. The native
 * global and actual-cwd sources remain native. Mirrors v2's nearest-to-farthest
 * AGENTS walk (home boundary when inside home, otherwise native project root).
 * Configuration instructions/globs are not invented as AGENTS replacements. */
async function capture(projectPath: string, cwd: string, projectRoot: string, homePath: string, signal: AbortSignal): Promise<Frozen> {
  const [start, execution, root, home] = await Promise.all([realpath(projectPath), realpath(cwd), realpath(projectRoot), realpath(homePath)]);
  // In-project Locations already have native ancestor discovery; injecting the
  // owner's chain there would duplicate or change the native ordering.
  if (!contains(root, start) || contains(root, execution)) throw new AgentError('invalid_configuration');
  const stop = contains(home, start) ? home : root;
  const sources: Source[] = [], seen = new Set<string>();
  for (let directory = start, depth = 0; ; directory = dirname(directory), depth++) {
    signal.throwIfAborted();
    if (depth >= 128) throw new AgentError('invalid_configuration');
    const source = await readSource(join(directory, 'AGENTS.md'));
    if (source && !seen.has(source.path)) { sources.push(source); seen.add(source.path); frozen(sources); }
    if (directory === stop) return frozen(sources);
    if (directory === dirname(directory)) throw new AgentError('invalid_configuration');
  }
}

/** Private durable instruction content; never put this DB in public artifacts.
 * Original Run/attempt/instance/project/cwd and one native session are bound.
 * A persisted dispatch intent is irreversible: after a lost PUT, only GET the
 * original entry; absence stays unknown instead of resending frozen content. */
export class OpenCodeProjectInstructions {
  private constructor(private readonly db: DatabaseSync, private readonly identity: OpenCodeInstanceIdentity, private readonly snapshot: Frozen) {}
  static async open(identity: OpenCodeInstanceIdentity, paths: { projectRoot: string; homePath: string }, signal: AbortSignal): Promise<OpenCodeProjectInstructions> {
    signal.throwIfAborted();
    identity = Object.freeze({ ...identity });
    if (!identity.projectPath || identity.projectPath === identity.cwd || !isAbsolute(identity.directory)) throw new AgentError('invalid_configuration');
    const path = join(identity.directory, 'project-instructions.sqlite'), db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS context (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, snapshot TEXT NOT NULL, session_id TEXT, attempted INTEGER NOT NULL DEFAULT 0);`);
      const owner = JSON.stringify([identity.runId, identity.attemptId, identity.instanceId, identity.projectPath, identity.cwd]);
      let row = db.prepare('SELECT * FROM context WHERE id = 1').get();
      if (!row) {
        const snapshot = await capture(identity.projectPath, identity.cwd, paths.projectRoot, paths.homePath, signal);
        signal.throwIfAborted();
        db.prepare('INSERT OR IGNORE INTO context (id, owner, snapshot) VALUES (1, ?, ?)').run(owner, JSON.stringify(snapshot));
        row = db.prepare('SELECT * FROM context WHERE id = 1').get();
      }
      if (!row || row.owner !== owner || typeof row.snapshot !== 'string' || Buffer.byteLength(row.snapshot) > maximumValueBytes * 3) throw new AgentError('outcome_unknown');
      const stored = JSON.parse(row.snapshot) as Frozen;
      if (!stored || !Array.isArray(stored.sources) || stored.sources.length > 128 || stored.sources.some(source =>
        typeof source.path !== 'string' || !isAbsolute(source.path) || typeof source.content !== 'string' || hash(source.content) !== source.sha256)) throw new AgentError('outcome_unknown');
      const snapshot = frozen(stored.sources);
      if (stored.value !== snapshot.value || stored.revision !== snapshot.revision) throw new AgentError('outcome_unknown');
      return new OpenCodeProjectInstructions(db, identity, snapshot);
    } catch (error) { db.close(); if (signal.aborted) throw signal.reason; if (error instanceof AgentError) throw error; throw new AgentError('outcome_unknown'); }
  }
  get revision(): string { return this.snapshot.revision; }
  get sourceCount(): number { return this.snapshot.sources.length; }
  async install(transport: Pick<OpenCodeTransport, 'request'>, sessionId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new AgentError('invalid_configuration');
    const sessionPath = '/api/session/' + sessionId;
    const info = await transport.request(sessionPath, { signal }) as { data?: { id?: unknown; location?: { directory?: unknown } } };
    if (info?.data?.id !== sessionId || info.data.location?.directory !== this.identity.cwd) throw new AgentError('outcome_unknown');
    this.db.prepare('UPDATE context SET session_id = ? WHERE id = 1 AND session_id IS NULL').run(sessionId);
    const binding = this.db.prepare('SELECT session_id FROM context WHERE id = 1').get();
    if (binding?.session_id !== sessionId) throw new AgentError('outcome_unknown');
    const entriesPath = '/api/experimental/session/' + sessionId + '/instructions/entries';
    const observed = async () => {
      const response = await transport.request(entriesPath, { signal }) as { data?: { key?: unknown; value?: unknown }[] };
      if (!Array.isArray(response?.data) || response.data.length > 1024) throw new AgentError('protocol_error');
      const entries = response.data.filter(entry => entry?.key === key);
      if (entries.length > 1 || entries.length === 1 && entries[0]!.value !== this.snapshot.value) throw new AgentError('outcome_unknown');
      return entries.length === 1;
    };
    if (await observed() || this.snapshot.sources.length === 0) return;
    signal.throwIfAborted();
    const claimed = this.db.prepare('UPDATE context SET attempted = 1 WHERE id = 1 AND attempted = 0').run();
    if (claimed.changes !== 1) throw new AgentError('outcome_unknown');
    try { await transport.request(entriesPath + '/' + key, { method: 'PUT', body: { value: this.snapshot.value }, signal }); }
    catch { /* Delivery may have succeeded. Query the original durable entry. */ }
    if (!await observed()) throw new AgentError('outcome_unknown');
  }
  close(): void { this.db.close(); }
}
