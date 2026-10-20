import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { OpenCodeActionJournal } from './journal.js';
import type { OpenCodeSdkBridgeOptions } from './sdk-bridge.js';
type Native = any;
/** Native snapshots remain private and never become Publication outputs. File
 * restore requires a caller-held busy period and a captured optimistic revision;
 * the final native restore hook checks every affected path again. */
export async function openCodeProjectOperations(options: OpenCodeSdkBridgeOptions, journal: OpenCodeActionJournal, db: DatabaseSync, load: (name: string) => Promise<Native>) {
  const [{ Effect, Layer, Context, Option }, { Session }, { Snapshot }, { Worktree }, { Project }] = await Promise.all([load('effect'), load('@opencode/core/session'), load('@opencode/core/snapshot'), load('@opencode/core/worktree'), load('@opencode/core/project')]);
  const RestoreGuard = Context.Service('workgraph/private/restore-guard');
  db.exec('CREATE TABLE IF NOT EXISTS owned_snapshot(id TEXT PRIMARY KEY,tree TEXT NOT NULL,files TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owned_worktree(id TEXT PRIMARY KEY,directory TEXT NOT NULL);');
  const owned = (sessionId: string) => journal.list().some(action => action.kind === 'session' && action.id === sessionId);
  async function fileHash(file: string): Promise<string | null> {
    const path = resolve(options.projectPath, file);
    if (isAbsolute(file) || !file || file.split(/[\/]/).includes('..') || !relative(options.projectPath, path) || relative(options.projectPath, path).startsWith('..')) throw Error('Invalid snapshot path');
    let parent = dirname(path);
    while (parent !== options.projectPath) { if (await realpath(parent) !== parent) throw Error('Snapshot path alias'); parent = dirname(parent); }
    if (await realpath(options.projectPath) !== options.projectPath) throw Error('Project path alias');
    try {
      const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error('Snapshot file is unavailable');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const current = await handle.stat(); if (stat.ino !== current.ino || stat.dev !== current.dev) throw Error('Snapshot changed'); const data = await handle.readFile(); if (data.length !== current.size) throw Error('Snapshot changed'); return createHash('sha256').update(data).update(String(current.mode)).digest('hex'); } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  const tracked = Snapshot.node.mapLayer((layer: Native) => Layer.effect(Snapshot.Service, Effect.gen(function* (): Native {
    const native = yield* Snapshot.Service;
    return { ...native, restore: (input: Native) => Effect.gen(function* (): Native {
      const guard = yield* Effect.serviceOption(RestoreGuard);
      if (Option.isNone(guard)) throw Error('Native file restore requires an explicit frozen revision');
      for (const file of input.files.keys()) {
        if (!Object.hasOwn(guard.value, file) || (yield* Effect.promise(() => fileHash(file))) !== guard.value[file]) throw Error('File restore conflicts with a later edit');
      }
      return yield* native.restore(input);
    }) };
  })).pipe(Layer.provide(layer)));
  const quiet = (sessionId: string) => Effect.gen(function* (): Native {
    if (!owned(sessionId) || options.cwd !== options.projectPath) throw Error('Project operation is unavailable in this location');
    const sessions = yield* Session.Service;
    if ((yield* sessions.active).size || (yield* sessions.inbox(sessionId)).length || journal.list().some(action => !['session'].includes(action.kind) && !action.id.startsWith('hold:') && !action.id.startsWith('project-operation:') && !['completed', 'failed', 'cancelled'].includes(action.phase))) throw Error('Native work is still active');
    if (!journal.list().some(action => action.id.startsWith('hold:') && action.phase === 'running')) throw Error('Project operation requires an explicit held busy period');
  });
  const capture = (sessionId: string) => Effect.gen(function* (): Native {
    const sessions = yield* Session.Service, snapshot = yield* Snapshot.Service;
    const context = yield* sessions.context(sessionId); if (context.length > 2048) throw Error('Snapshot history budget');
    const session = yield* sessions.get(sessionId);
    const paths = new Set<string>(context.flatMap((message: Native) => message.type === 'assistant' ? message.snapshot?.files ?? [] : []));
    for (const file of session.revert?.files ?? []) paths.add(file.file);
    if (paths.size > 2048) throw Error('Snapshot file budget');
    const files: Record<string, string | null> = Object.create(null);
    for (const file of paths) files[file] = yield* Effect.promise(() => fileHash(file));
    const tree = yield* snapshot.capture(); if (!tree) throw Error('Native snapshots are unavailable');
    const id = 'snapshot_' + randomUUID();
    db.prepare('INSERT INTO owned_snapshot VALUES(?,?,?)').run(id, tree, JSON.stringify(files)); return { snapshotId: id };
  });
  return { override: Snapshot.node.replace(tracked), request: (body: Native) => Effect.gen(function* (): Native {
    const sessions = yield* Session.Service, snapshot = yield* Snapshot.Service;
    if (body.type.startsWith('worktree.')) {
      if (options.permissionMode !== 'danger-full-access') throw Error('Worktree requires full native permission');
      const worktrees = yield* Worktree.Service, project = yield* (yield* Project.Service).resolve(options.projectPath);
      if (body.type === 'worktree.list') return db.prepare('SELECT id FROM owned_worktree ORDER BY id').all();
      yield* quiet(body.sessionId);
      if (body.type === 'worktree.create') {
        const id = 'worktree_' + body.callId, directory = join(options.directory, 'worktrees');
        yield* Effect.promise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
        const result = yield* worktrees.create({ projectID: project.id, from: options.projectPath, directory, name: id, ...(body.branch ? { branch: body.branch } : {}) });
        if (awaitPathEscapes(directory, result.directory)) throw Error('Native worktree escaped its owned directory');
        db.prepare('INSERT INTO owned_worktree VALUES(?,?)').run(id, result.directory); return { worktreeId: id };
      }
      const record = db.prepare('SELECT directory FROM owned_worktree WHERE id=?').get(body.worktreeId); if (!record) throw Error('Unowned worktree');
      if (body.type === 'worktree.remove') { yield* worktrees.remove({ projectID: project.id, directory: String(record.directory), force: false }); db.prepare('DELETE FROM owned_worktree WHERE id=?').run(body.worktreeId); return { removed: true }; }
      throw Error('Cannot switch a frozen Run project');
    }
    yield* quiet(body.sessionId);
    if (body.type === 'snapshot.capture') return yield* capture(body.sessionId);
    const record = db.prepare('SELECT tree,files FROM owned_snapshot WHERE id=?').get(body.expectedSnapshot);
    if (!record || (yield* snapshot.capture()) !== record.tree) return { conflict: true };
    const files = JSON.parse(String(record.files));
    for (const [file, hash] of Object.entries(files)) if ((yield* Effect.promise(() => fileHash(file))) !== hash) return { conflict: true };
    if (body.type === 'revert.apply') yield* sessions.revert.stage({ sessionID: body.sessionId, messageID: body.messageId, files: true }).pipe(Effect.provideService(RestoreGuard, files));
    else if (body.type === 'revert.undo') yield* sessions.revert.clear(body.sessionId).pipe(Effect.provideService(RestoreGuard, files));
    else if (body.type === 'revert.commit') yield* sessions.revert.commit(body.sessionId);
    else throw Error('Unsupported native project operation');
    return { applied: true, ...(yield* capture(body.sessionId)) };
  }) };
}
function awaitPathEscapes(root: string, path: string) { const result = relative(root, path); return !result || result.startsWith('..') || isAbsolute(result); }
