import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { captureOpenCodeShellProcess, stopObservedOpenCodeShellGroup } from './process-evidence.js';
import type { OpenCodeActionJournal } from './journal.js';
import type { OpenCodeSdkBridgeOptions } from './sdk-bridge.js';
import { validOpenCodePtyCommand } from './sdk-pty.js';
type Native = any;
const terminal = (phase: string) => ['completed', 'failed', 'cancelled'].includes(phase);
/** The native daemon lives in this attempt's private directory. Its ownership
 * registration never leaves the worker; only process identity is journaled. */
export async function openCodePersistentPtyBridge(options: OpenCodeSdkBridgeOptions, journal: OpenCodeActionJournal, load: (name: string) => Promise<Native>, accepting: () => boolean) {
  const [{ Effect, Layer }, { PersistentPty }] = await Promise.all([load('effect'), load('@opencode/core/persistent-pty/index')]);
  const root = join(options.directory, 'persistent-pty');
  const owned = (id: string) => journal.list().find(action => action.kind === 'pty' && journal.nativeId('pty', action.id) === id);
  let daemonId: string | undefined;
  const available = async () => {
    if (process.platform === 'win32') return false;
    const binary = process.env.OPENCODE_PTY_BIN ?? 'opencode-pty';
    for (const path of isAbsolute(binary) || binary.includes('/') ? [resolve(binary)] : (process.env.PATH ?? '').split(':').map(path => join(path, binary))) { try { await access(path, constants.X_OK); if ((await lstat(path)).isFile()) return true; } catch {} }
    return false;
  };
  const exited = (id: string, code: number) => { const action = owned(id); if (action && !terminal(action.phase)) journal.observe(options.instanceId, 'pty', action.id, code === 0 ? 'completed' : 'failed', code); };
  async function rememberDaemon() {
    const names = await readdir(root); if (names.length > 32) throw Error('Daemon registration budget');
    const found = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}$/.test(name)) throw Error('Unexpected daemon directory');
      const path = join(root, name, 'service.json');
      try {
        if (await realpath(path) !== path) throw Error('Daemon registration alias');
        const stat = await lstat(path); if (!stat.isFile() || stat.size > 65536 || process.getuid && stat.uid !== process.getuid()) throw Error('Invalid daemon registration');
        const record = JSON.parse(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || typeof record.instance_id !== 'string') throw Error('Invalid daemon process');
        found.push(record);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (found.length !== 1 || !daemonId) throw Error('Daemon ownership is not unique');
    const record = found[0]; journal.bindNative('process', daemonId, record.instance_id, record.pid);
    journal.rememberProcess('process', daemonId, await captureOpenCodeShellProcess(options.instanceId, record.pid));
  }
  const configured = PersistentPty.configured({ root });
  const tracked = configured.mapLayer((layer: Native) => Layer.effect(PersistentPty.Service, Effect.gen(function* (): Native {
    const native = yield* PersistentPty.Service, scope = yield* Effect.scope;
    const stop = (id: string) => Effect.gen(function* (): Native {
      const action = owned(id); if (!action) throw Error('Unowned persistent PTY');
      const current = yield* native.get(id); if (current.status === 'exited') { exited(id, current.exitCode); return; }
      const evidence = journal.shellProcess(action.id); if (!evidence) throw Error('Persistent PTY process is unknown');
      yield* Effect.promise(() => stopObservedOpenCodeShellGroup(evidence));
      for (let pass = 0; pass < 200; pass++) { const value = yield* native.get(id); if (value.status === 'exited' && Number.isSafeInteger(value.exitCode)) { exited(id, value.exitCode); return; } yield* Effect.sleep('10 millis'); }
      throw Error('Persistent PTY exit is not confirmed');
    });
    return { ...native, create: (sessionId: string, input: Native) => Effect.gen(function* (): Native {
      if (!accepting() || options.permissionMode !== 'danger-full-access' || input.cwd !== options.cwd || !journal.list().some(action => action.kind === 'session' && action.id === sessionId)) throw Error('Persistent PTY is unavailable');
      if (!(yield* Effect.promise(available))) throw Error('Native persistent PTY binary is unavailable');
      if (!daemonId) { daemonId = 'persistent-daemon:' + randomUUID(); journal.register({ kind: 'process', id: daemonId }); journal.observe(options.instanceId, 'process', daemonId, 'running'); }
      const id = 'persistent-pty:' + randomUUID(); journal.register({ kind: 'pty', id, sessionId }); journal.observe(options.instanceId, 'pty', id, 'running');
      const value = yield* native.create(sessionId, { ...input, cwd: options.cwd, env: { WORKGRAPH_OPENCODE_INSTANCE_ID: options.instanceId } });
      journal.bindNative('pty', id, value.id, value.pid);
      yield* Effect.promise(rememberDaemon);
      yield* Effect.promise(async () => { try { journal.rememberProcess('pty', id, await captureOpenCodeShellProcess(options.instanceId, value.pid)); } catch {} });
      yield* Effect.gen(function* (): Native { while (true) { const current = yield* native.get(value.id); if (current.status === 'exited') { exited(value.id, current.exitCode); return; } yield* Effect.sleep('25 millis'); } }).pipe(Effect.forkIn(scope, { startImmediately: true }));
      return value;
    }), remove: (id: string) => stop(id).pipe(Effect.andThen(native.remove(id))), shutdown: () => Effect.gen(function* (): Native {
      if (journal.list().some(action => action.kind === 'pty' && action.id.startsWith('persistent-pty:') && !terminal(action.phase))) throw Error('Persistent terminals are still active');
      // A daemon can close its socket before its acknowledgement arrives.
      // Finish through the independently recorded original process group.
      yield* native.shutdown().pipe(Effect.ignore);
      if (daemonId) {
        const id = daemonId, evidence = journal.shellProcess(id); if (!evidence) throw Error('Daemon exit is unknown');
        yield* Effect.promise(() => stopObservedOpenCodeShellGroup(evidence));
        journal.observe(options.instanceId, 'process', id, 'completed');
        // A continuation starts a new daemon and needs its own immutable evidence.
        if (daemonId === id) daemonId = undefined;
      }
    }) };
  })).pipe(Layer.provide(layer)));
  const preflight = (body: Native) => Effect.gen(function* (): Native {
    if (!body || !['persistentPty.create', 'persistentPty.read', 'persistentPty.write', 'persistentPty.stop'].includes(body.type)) throw Error('Unsupported persistent PTY operation');
    if (body.type === 'persistentPty.create') {
      if (options.permissionMode !== 'danger-full-access') return { unsupported: true, reason: 'native_pty_full_access_required' };
      if (!accepting() || !validOpenCodePtyCommand(body) || !journal.list().some(action => action.kind === 'session' && action.id === body.sessionId)) throw Error('Invalid persistent PTY command');
    } else {
      if (!owned(body.ptyId)) throw Error('Unowned persistent terminal');
      if (body.type === 'persistentPty.write' && (!accepting() || typeof body.text !== 'string' || Buffer.byteLength(body.text) > 16384)) throw Error('Invalid persistent PTY input');
    }
    if (!(yield* Effect.promise(available))) return { unsupported: true, reason: 'native_persistent_pty_unavailable' };
    if (body.type !== 'persistentPty.create') yield* (yield* PersistentPty.Service).get(body.ptyId);
    return null;
  });
  return { override: PersistentPty.node.replace(tracked),
    preflight,
    seal: Effect.gen(function* (): Native { if (daemonId) yield* (yield* PersistentPty.Service).shutdown(); }),
    cancel: Effect.gen(function* (): Native { const native = yield* PersistentPty.Service; for (const action of journal.list().filter(action => action.kind === 'pty' && action.id.startsWith('persistent-pty:') && !terminal(action.phase))) { const id = journal.nativeId('pty', action.id); if (id) yield* native.remove(id); } }),
    request: (body: Native) => Effect.gen(function* (): Native {
      const unsupported = yield* preflight(body); if (unsupported) return unsupported;
      const native = yield* PersistentPty.Service;
      if (body.type === 'persistentPty.create') { const value = yield* native.create(body.sessionId, { command: body.command, args: body.args, cwd: options.cwd, title: 'Run terminal', env: {} }); return { id: value.id, status: value.status }; }
      if (body.type === 'persistentPty.stop') { yield* native.remove(body.ptyId); return { stopped: true }; }
      if (body.type === 'persistentPty.write') { if (!accepting()) throw Error('Run is stopping'); yield* native.write(body.ptyId, body.text); }
      const value = yield* native.snapshot(body.ptyId);
      return { id: value.info.id, status: value.info.status, ...(value.info.exitCode === undefined ? {} : { exitCode: value.info.exitCode }), text: value.text.slice(-32768) };
    }),
  };
}
