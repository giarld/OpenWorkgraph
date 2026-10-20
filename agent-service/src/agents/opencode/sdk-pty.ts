import { randomUUID } from 'node:crypto';
import { captureOpenCodeShellProcess, stopObservedOpenCodeShellGroup } from './process-evidence.js';
import type { OpenCodeActionJournal } from './journal.js';
import type { OpenCodeSdkBridgeOptions } from './sdk-bridge.js';
type Native = any;
export const validOpenCodePtyCommand = (body: Native): boolean => typeof body.command === 'string' && !!body.command && !body.command.includes(String.fromCharCode(0)) && body.command.length <= 4096 && Array.isArray(body.args) && body.args.length <= 128 && body.args.every((arg: unknown) => typeof arg === 'string' && arg.length <= 16000 && !arg.includes(String.fromCharCode(0)));
/** Native PTY only. No shell fallback, public websocket ticket, arbitrary cwd
 * or child environment. Removal waits for the retained native exit record. */
export async function openCodePtyBridge(options: OpenCodeSdkBridgeOptions, journal: OpenCodeActionJournal, load: (name: string) => Promise<Native>, accepting: () => boolean) {
  const [{ Effect, Layer }, { Pty }] = await Promise.all([load('effect'), load('@opencode/core/pty')]);
  const outputs = new Map<string, string>();
  const ended = (id: string, code: number) => {
    const action = journal.list().find(action => action.kind === 'pty' && action.id === id);
    if (action && !['completed', 'failed', 'cancelled'].includes(action.phase)) journal.observe(options.instanceId, 'pty', id, code === 0 ? 'completed' : 'failed', code);
  };
  const tracked = Pty.node.mapLayer((layer: Native) => Layer.effect(Pty.Service, Effect.gen(function* (): Native {
    const native = yield* Pty.Service, scope = yield* Effect.scope;
    const stop = (nativeId: string) => Effect.gen(function* (): Native {
      const action = journal.list().find(action => action.kind === 'pty' && journal.nativeId('pty', action.id) === nativeId);
      if (!action) throw Error('Unowned PTY');
      const before = yield* native.get(nativeId);
      if (before.status === 'exited') { ended(action.id, before.exitCode); return; }
      const evidence = journal.shellProcess(action.id);
      if (!evidence) throw Error('PTY process ownership is unknown');
      yield* Effect.promise(() => stopObservedOpenCodeShellGroup(evidence));
      for (let pass = 0; pass < 200; pass++) {
        const current = yield* native.get(nativeId);
        if (current.status === 'exited' && Number.isSafeInteger(current.exitCode)) { ended(action.id, current.exitCode); return; }
        yield* Effect.sleep('10 millis');
      }
      throw Error('PTY exit is not confirmed');
    });
    return { ...native, create: (input: Native) => Effect.gen(function* (): Native {
      if (!accepting() || !['darwin', 'linux'].includes(process.platform) || options.permissionMode !== 'danger-full-access' || input.cwd !== options.cwd) throw Error('PTY is unavailable for this frozen Run');
      const id = 'pty:' + randomUUID(); journal.register({ kind: 'pty', id }); journal.observe(options.instanceId, 'pty', id, 'running');
      const info = yield* native.create({ ...input, cwd: options.cwd, env: {} });
      journal.bindNative('pty', id, info.id, info.pid);
      yield* Effect.promise(async () => { try { journal.rememberProcess('pty', id, await captureOpenCodeShellProcess(options.instanceId, info.pid)); } catch { /* Fast exit is observed by native get. */ } });
      outputs.set(info.id, '');
      const current = yield* native.get(info.id);
      if (current.status === 'exited') ended(id, current.exitCode);
      else {
        const attachment = yield* native.attach(info.id, { onData: (data: string) => outputs.set(info.id, ((outputs.get(info.id) ?? '') + data).slice(-32768)), onEnd: (event: Native) => { if (Number.isSafeInteger(event.exitCode)) ended(id, event.exitCode); } });
        outputs.set(info.id, attachment.replay.slice(-32768)); attachment.activate();
        yield* Effect.gen(function* (): Native {
          while (true) { const value = yield* native.get(info.id); if (value.status === 'exited') { ended(id, value.exitCode); return; } yield* Effect.sleep('25 millis'); }
        }).pipe(Effect.forkIn(scope, { startImmediately: true }));
      }
      return info;
    }), remove: (id: string) => stop(id).pipe(Effect.andThen(native.remove(id))) };
  })).pipe(Layer.provide(layer)));
  // Read-only validation runs before the worker reserves any invocation/action.
  const preflight = (body: Native) => Effect.gen(function* (): Native {
    if (!body || !['pty.create', 'pty.read', 'pty.write', 'pty.stop'].includes(body.type)) throw Error('Unsupported PTY operation');
    if (body.type === 'pty.create') {
      if (options.permissionMode !== 'danger-full-access') return { unsupported: true, reason: 'native_pty_full_access_required' };
      if (!['darwin', 'linux'].includes(process.platform)) return { unsupported: true, reason: 'native_pty_lifecycle_unavailable' };
      if (!accepting() || !validOpenCodePtyCommand(body)) throw Error('Invalid PTY command');
    } else {
      if (typeof body.ptyId !== 'string' || !journal.list().some(action => action.kind === 'pty' && journal.nativeId('pty', action.id) === body.ptyId)) throw Error('Unowned PTY');
      if (body.type === 'pty.write' && (!accepting() || typeof body.text !== 'string' || Buffer.byteLength(body.text) > 16384)) throw Error('Invalid PTY input');
      yield* (yield* Pty.Service).get(body.ptyId);
    }
    return null;
  });
  return { override: Pty.node.replace(tracked),
    preflight,
    cancel: Effect.gen(function* (): Native { const native = yield* Pty.Service; for (const action of journal.list().filter(action => action.kind === 'pty' && action.id.startsWith('pty:') && !['completed', 'failed', 'cancelled'].includes(action.phase))) { const id = journal.nativeId('pty', action.id); if (id) yield* native.remove(id); } }),
    request: (body: Native) => Effect.gen(function* (): Native {
      const unsupported = yield* preflight(body); if (unsupported) return unsupported;
      const native = yield* Pty.Service;
      if (body.type === 'pty.create') {
        const value = yield* native.create({ command: body.command, args: body.args, cwd: options.cwd, title: 'Run terminal' });
        return { id: value.id, status: value.status };
      }
      if (body.type === 'pty.stop') { yield* native.remove(body.ptyId); return { stopped: true }; }
      const info = yield* native.get(body.ptyId);
      if (body.type === 'pty.write') yield* native.write(body.ptyId, body.text);
      return { id: info.id, status: info.status, ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }), text: outputs.get(info.id) ?? '' };
    }),
  };
}
