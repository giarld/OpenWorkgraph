import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenCodeActionJournal } from './journal.js';
import { captureOpenCodeShellProcess, openCodeGroupRunning, stopObservedOpenCodeShellGroup, stopOpenCodeNativeProcessGroup } from './process-evidence.js';
import { redactSkillValues } from '../../backend/redaction.js';
import { openCodePermissionRules } from './permissions.js';
import { openCodePtyBridge } from './sdk-pty.js';
import { openCodeProjectOperations } from './sdk-project-operations.js';
import { openCodePersistentPtyBridge } from './sdk-persistent-pty.js';
import type { SandboxMode } from '@openworkgraph/protocol';

/** Pinned native Effect services are deliberately loaded only in the private
 * worker. No OpenCode dependency or raw native context enters host contracts. */
type Native = any;
export interface OpenCodeSdkBridgeOptions {
  directory: string; runId: string; attemptId: string; instanceId: string;
  projectPath: string; cwd: string; permissionMode: string;
  runsPath?: string;
  recoverable?: boolean; selectionDigest?: string;
  host?: { url: string; token: string; tools: { name: string; description: string; inputSchema: unknown }[] };
}
export async function createOpenCodeSdkBridge(options: OpenCodeSdkBridgeOptions, load: (name: string) => Promise<Native>) {
  const [{ Effect, Layer, Context, Option, Exit, Cause, Fiber }, { Shell }, { Job }, { Permission }, { Tool }, { Session }, { LocationServiceMap }, { Location }, { CrossSpawnSpawner }, Spawner, { define }, { PluginHooks }, { Agent }, { ConfigPluginSource }, { Mcp }, { Config }, { McpTool }] = await Promise.all([
    load('effect'), load('@opencode/core/shell'), load('@opencode/core/job'), load('@opencode/core/permission'), load('@opencode/core/tool'), load('@opencode/core/session'), load('@opencode/core/location-services'), load('@opencode/core/location'),
    load('@opencode/util/cross-spawn-spawner'), load('effect/process/ChildProcessSpawner'), load('@opencode/plugin/effect/plugin'), load('@opencode/core/plugin/hooks'), load('@opencode/core/agent'), load('@opencode/core/config/plugin/source'), load('@opencode/core/mcp/index'), load('@opencode/core/config'), load('@opencode/core/tool/mcp'),
  ]);
  const journal = new OpenCodeActionJournal(options.directory, options);
  const commandPath = join(options.directory, 'commands.sqlite'), commands = new DatabaseSync(commandPath); chmodSync(commandPath, 0o600);
  commands.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS invocation (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT);');
  const privateValues: Record<string, string> = {};
  const clean = (value: unknown) => JSON.parse(redactSkillValues(JSON.stringify(value), privateValues));
  const CommandContext = Context.Service('workgraph/private/skill-command');
  const modeRules = openCodePermissionRules(options.permissionMode as SandboxMode, options.projectPath, options.runsPath ?? options.cwd);
  const terminal = (kind: Native, id: string, phase: Native, code: number | null = null) => {
    const old = journal.list().find(action => action.kind === kind && action.id === id);
    if (old && !['completed', 'failed', 'cancelled'].includes(old.phase)) journal.observe(options.instanceId, kind, id, phase, code);
  };
  const reserve = (kind: Native, id: string, sessionId?: string) => {
    journal.register({ kind, id, ...(sessionId ? { sessionId } : {}) }); journal.observe(options.instanceId, kind, id, 'running');
  };
  const posixGroups = ['darwin', 'linux'].includes(process.platform), stoppingActions = new Set<string>();
  const afterProcessExit = (kind: Native, id: string, pid: number, phase: Native, code: number | null = null, detached = true) => Effect.gen(function* (): Native {
    // Native wait/exitCode observe only the leader. Redirected background
    // children can outlive it without holding stdout/stderr open.
    if (posixGroups && detached) while (yield* Effect.tryPromise(() => openCodeGroupRunning(pid))) yield* Effect.sleep('50 millis');
    terminal(kind, id, stoppingActions.has(id) && phase !== 'unknown' ? 'cancelled' : phase, code);
  }).pipe(Effect.catchCause(() => Effect.sync(() => terminal(kind, id, 'unknown'))));
  let accepting = true, host: Native;
  const reconnectMcp = new Set<string>();
  const pty = await openCodePtyBridge(options, journal, load, () => accepting && !projectBusy);
  const persistentPty = await openCodePersistentPtyBridge(options, journal, load, () => accepting && !projectBusy);
  const projectOperations = await openCodeProjectOperations(options, journal, commands, load);
  let projectBusy = false;
  let paused = false;
  let executionScope: Native;
  const auxiliary = new Map<string, Native>();
  const commandFibers = new Map<string, Native>();
  // Native Shell starts its spawn in a separate fiber. The exact invocation
  // environment object survives that handoff without injecting markers into
  // the child's environment or relying on command strings/observation order.
  const shellInvocations = new WeakMap<object, string>();
  const deniedTool = (name: string) => Permission.evaluate(['write', 'patch'].includes(name) ? 'edit' : name, '*', modeRules).effect === 'deny';
  const trackedSessions = Session.node.mapLayer((layer: Native) => Layer.effect(Session.Service, Effect.gen(function* (): Native {
    const native = yield* Session.Service, scope = yield* Effect.scope;
    return { ...native, generate: (input: Native) => Effect.gen(function* (): Native {
      if (!accepting) throw Error('The owning Run is not accepting auxiliary inference');
      const id = 'generate:' + randomUUID(); reserve('plugin', id, input.sessionID);
      const fiber = yield* native.generate(input).pipe(Effect.onExit((exit: Native) => Effect.sync(() => { auxiliary.delete(id); terminal('plugin', id, Exit.isSuccess(exit) ? 'completed' : Cause.hasInterruptsOnly(exit.cause) ? 'cancelled' : 'failed'); })), Effect.forkIn(scope, { startImmediately: true }));
      auxiliary.set(id, fiber);
      return yield* Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber).pipe(Effect.andThen(Effect.sync(() => auxiliary.delete(id))))));
    }) };
  })).pipe(Layer.provide(layer)));
  const trackedTools = Tool.node.mapLayer((layer: Native) => Layer.effect(Tool.Service, Effect.gen(function* (): Native {
    const native = yield* Tool.Service;
    const wrapped = new WeakSet();
    const wrap = (tool: Native) => {
      if (wrapped.has(tool.execute)) return tool;
      const execute = (input: Native, context: Native) => Effect.gen(function* (): Native {
        if (!accepting || projectBusy) return yield* Effect.fail(new Tool.Error({ message: 'The owning Run is not accepting native tools.' }));
        const id = 'tool:' + randomUUID(); reserve('plugin', id, context.sessionID);
        journal.bindNative('plugin', id, createHash('sha256').update(JSON.stringify([context.sessionID, context.messageID, context.id, tool.name])).digest('hex'));
        return yield* tool.execute(input, context).pipe(Effect.onExit((exit: Native) => Effect.sync(() => terminal('plugin', id, Exit.isSuccess(exit) ? 'completed' : 'failed'))));
      });
      wrapped.add(execute); return { ...tool, execute };
    };
    return { ...native,
      transform: (edit: Native) => native.transform((editor: Native) => edit({ ...editor, add: (tool: Native) => editor.add(wrap(tool)), update: (id: string, update: Native) => editor.update(id, (tool: Native) => { update(tool); Object.assign(tool, wrap({ ...tool })); }) })),
      snapshot: (...args: Native[]) => native.snapshot(...args).pipe(Effect.map((snapshot: Native) => ({
      ...snapshot, ...(deniedTool('execute') ? { codeModeCatalog: undefined } : {}),
      definitions: snapshot.definitions.filter((definition: Native) => !deniedTool(definition.name)),
      execute: (input: Native) => Effect.suspend(() => {
        if (!accepting || projectBusy || deniedTool(input.call.name)) return Effect.fail(new Tool.Error({ message: 'Tool is unavailable for the frozen Run permissions.' }));
        const id = 'call:' + randomUUID(); reserve('plugin', id, input.sessionID);
        return snapshot.execute(input).pipe(Effect.onExit((exit: Native) => Effect.sync(() => terminal('plugin', id, Exit.isSuccess(exit) ? 'completed' : 'failed'))));
      }),
    }))) };
  })).pipe(Layer.provide(layer)));
  const trackedSpawner = CrossSpawnSpawner.node.mapLayer((layer: Native) => Layer.effect(Spawner.ChildProcessSpawner, Effect.gen(function* (): Native {
    const native = yield* Spawner.ChildProcessSpawner, scope = yield* Effect.scope;
    return Spawner.make((command: Native) => Effect.gen(function* (): Native {
      if (!accepting) throw Error('The owning Run is not accepting native processes');
      const id = 'process:' + randomUUID();
      const shellId = command.options?.env && shellInvocations.get(command.options.env);
      journal.register({ kind: 'process', id, ...(shellId ? { parentId: shellId } : {}) });
      journal.observe(options.instanceId, 'process', id, 'running');
      const handle = yield* native.spawn(command).pipe(Effect.onExit((exit: Native) => Effect.sync(() => {
        if (!Exit.isFailure(exit)) return;
        const failure = Cause.findErrorOption(exit.cause);
        const reason = Option.isSome(failure) ? failure.value.reason : undefined;
        // An OS spawn refusal proves no executable started. Other failures or
        // interruption can occur after launch and must retain unknown work.
        const refused = reason?.module === 'ChildProcess' && reason.method === 'spawn' && ['ENOENT', 'EACCES', 'ENOTDIR', 'ENOEXEC'].includes(reason.cause?.code);
        terminal('process', id, refused ? 'failed' : 'unknown');
      })));
      journal.bindNative('process', id, String(handle.pid), Number(handle.pid));
      yield* handle.exitCode.pipe(Effect.matchCauseEffect({
        onSuccess: (code: number) => afterProcessExit('process', id, Number(handle.pid), code === 0 ? 'completed' : 'failed', code, command.options?.detached !== false),
        onFailure: (cause: Native) => {
          const failure = Cause.findErrorOption(cause);
          return afterProcessExit('process', id, Number(handle.pid), Option.isSome(failure) && failure.value.cause instanceof CrossSpawnSpawner.KilledBySignal ? 'cancelled' : 'unknown', null, command.options?.detached !== false);
        },
      }), Effect.forkIn(scope, { startImmediately: true }));
      return handle;
    }));
  })).pipe(Layer.provide(layer)));
  const trackedJobs = Job.node.mapLayer((layer: Native) => Layer.effect(Job.Service, Effect.gen(function* (): Native {
    const native = yield* Job.Service;
    executionScope = yield* Effect.scope;
    return { ...native, start: (input: Native) => Effect.gen(function* (): Native {
      if (!accepting) throw Error('The owning Run is not accepting native jobs');
      const previous = journal.list().find(action => action.kind === 'plugin' && action.id.startsWith('job:') && journal.nativeId(action.kind, action.id) === input.id && !['completed', 'failed', 'cancelled'].includes(action.phase));
      if (previous) return yield* native.start(input);
      const id = 'job:' + randomUUID();
      reserve('plugin', id, input.recovery?.parentSessionID ?? input.recovery?.sessionID);
      journal.bindNative('plugin', id, input.id);
      const run = input.run.pipe(Effect.onExit((exit: Native) => Effect.sync(() => terminal('plugin', id, Exit.isSuccess(exit) ? 'completed' : 'failed'))));
      return yield* native.start({ ...input, run });
    }) };
  })).pipe(Layer.provide(layer)));
  const trackedShell = Shell.node.mapLayer((layer: Native) => Layer.effect(Shell.Service, Effect.gen(function* (): Native {
    const native = yield* Shell.Service, scope = yield* Effect.scope;
    return { ...native, create: (input: Native, before: Native) => Effect.gen(function* (): Native {
      const id = 'shell:' + randomUUID(); reserve('shell', id, input.metadata?.sessionID);
      const invocation = yield* Effect.serviceOption(CommandContext);
      let dispatchReady = false;
      const checkedBefore = (event: Native) => Effect.gen(function* (): Native {
        if (before) yield* before(event);
        if (!accepting) throw Error('Run is stopping');
        if (Option.isSome(invocation)) {
          const frozen = invocation.value;
          if (event.command !== frozen.command || event.cwd !== frozen.cwd || event.shell !== '/bin/sh' || Object.entries(frozen.environment).some(([key, value]) => event.env[key] !== value)) throw Error('Frozen native invocation changed');
        } else if (options.permissionMode !== 'danger-full-access' && !before) throw Error('Unapproved native shell path');
        // Native Shell.create only spawns after this callback succeeds.
        dispatchReady = true;
        shellInvocations.set(event.env, id);
        if (Option.isSome(invocation)) invocation.value.dispatched = true;
      });
      const info = yield* native.create(input, checkedBefore).pipe(Effect.onExit((exit: Native) => Effect.sync(() => {
        if (Exit.isFailure(exit)) terminal('shell', id, dispatchReady ? 'unknown' : Cause.hasInterruptsOnly(exit.cause) ? 'cancelled' : 'failed');
      })));
      journal.bindNative('shell', id, info.id, info.pid);
      if (info.pid && ['darwin', 'linux'].includes(process.platform)) {
        yield* Effect.promise(async () => { try { journal.rememberShellProcess(id, await captureOpenCodeShellProcess(options.instanceId, info.pid)); } catch { /* Fast leaders still retain the group exit barrier below. */ } });
      }
      yield* native.wait(info.id).pipe(Effect.matchCauseEffect({
        onSuccess: (value: Native) => afterProcessExit('shell', id, info.pid, value.status === 'exited' ? value.exit === 0 ? 'completed' : 'failed' : 'cancelled', value.exit ?? null),
        onFailure: () => Effect.sync(() => terminal('shell', id, 'unknown')),
      }), Effect.forkIn(scope, { startImmediately: true }));
      return info;
    }) };
  })).pipe(Layer.provide(layer)));
  // Reject before user module import or MCP connection. Native extension code
  // can create side effects outside tool permission checks and cannot be
  // represented as a restricted-mode sandbox by the host.
  const restrictedSources = ConfigPluginSource.node.mapLayer((layer: Native) => Layer.effect(ConfigPluginSource.Service, Effect.gen(function* (): Native {
    const native = yield* ConfigPluginSource.Service;
    return { ...native, operations: () => native.operations().pipe(Effect.map((operations: Native[]) => {
      if (options.permissionMode !== 'danger-full-access' && operations.some(operation => operation.type === 'add')) throw Error('Restricted Run cannot load unaudited native plugins');
      return operations;
    })) };
  })).pipe(Layer.provide(layer)));
  const restrictedMcp = Mcp.node.mapLayer((layer: Native) => Layer.effect(Mcp.Service, Effect.gen(function* (): Native {
    const native = yield* Mcp.Service;
    const check = () => { if (options.permissionMode !== 'danger-full-access') throw Error('Restricted Run cannot connect unaudited MCP'); };
    return { ...native, add: (...args: Native[]) => Effect.suspend(() => { check(); return native.add(...args); }), connect: (...args: Native[]) => Effect.suspend(() => { check(); return native.connect(...args); }),
      transform: (edit: Native) => native.transform((editor: Native) => edit({ ...editor, set: (...args: Native[]) => { check(); return editor.set(...args); }, update: (...args: Native[]) => { check(); return editor.update(...args); } })) };
  })).pipe(Layer.provide(layer)));
  async function canonicalResource(resource: string): Promise<string> {
    let path = resolve(options.cwd, resource), suffix: string[] = [];
    while (true) {
      try { return resolve(await realpath(path), ...suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw Error('Cannot resolve native permission resource'); suffix.unshift(path.slice(dirname(path).length + 1)); path = dirname(path); }
    }
  }
  // Resource spelling remains native so project-relative user rules retain
  // their meaning. Frozen mode ceilings are enforced after native hooks below.
  const frozenHooks = PluginHooks.node.mapLayer((layer: Native) => Layer.effect(PluginHooks.Service, Effect.gen(function* (): Native {
    const native = yield* PluginHooks.Service;
    return { ...native, trigger: (domain: string, name: string, input: Native) => native.trigger(domain, name, input).pipe(Effect.flatMap((event: Native) => Effect.gen(function* (): Native {
      if (domain !== 'permission' || name !== 'evaluate') return event;
      const resources = ['edit', 'read', 'external_directory'].includes(event.action) ? yield* Effect.promise(() => Promise.all(event.resources.map((resource: string) => canonicalResource(resource.endsWith('/*') ? resource.slice(0, -2) : resource)))) : event.resources;
      const effects = resources.map((resource: string) => Permission.evaluate(event.action, resource, modeRules).effect);
      if (effects.includes('deny')) event.effect = 'deny'; else if (event.effect !== 'deny' && effects.includes('ask')) event.effect = 'ask';
      return event;
    }))) };
  })).pipe(Layer.provide(layer)));
  const plugin = define({ id: 'workgraph.private.bridge', effect: Effect.fn(function* (ctx: Native): Native {
    yield* ctx.tool.hook('execute.before', (event: Native) => Effect.sync(() => {
      if (!accepting || projectBusy || deniedTool(event.tool)) throw new Tool.Error({ message: 'The owning Run is stopping or this tool is unavailable.' });
      if (/^(?:session_|terminal_|pty_|worktree_)/.test(event.tool)) throw new Tool.Error({ message: 'This operation requires an explicitly owned host operation.' });
    }));
    yield* ctx.tool.hook('execute.after', (event: Native) => Effect.sync(() => {
      if (event.status === 'completed') event.result = clean(event.result);
    }));
    yield* ctx.shell.hook('create.before', (event: Native) => Effect.gen(function* (): Native {
      const command = yield* Effect.serviceOption(CommandContext);
      if (Option.isSome(command)) { event.command = command.value.command; event.cwd = command.value.cwd; event.env = { ...event.env, ...command.value.environment }; event.shell = '/bin/sh'; }
    }));
    yield* ctx.tool.transform((editor: Native) => {
      for (const tool of options.host?.tools ?? []) editor.add({ name: tool.name, description: tool.description, input: tool.inputSchema, options: { codemode: false },
        execute: (input: Native, call: Native) => Effect.promise(async () => {
          if (!accepting) throw Error('Run stopped');
          const response = await fetch(options.host!.url, { method: 'POST', headers: { authorization: 'Bearer ' + options.host!.token, 'content-type': 'application/json' },
            body: JSON.stringify({ name: tool.name, arguments: input, callId: createHash('sha256').update(JSON.stringify([call.sessionID, call.messageID, call.id, tool.name])).digest('hex'), sessionId: call.sessionID }), signal: call.signal });
          if (!response.ok) throw Error('Host tool rejected');
          const result = await response.json() as Native;
          return { content: typeof result.content === 'string' ? result.content : JSON.stringify(result) };
        }) });
    });
  }) });
  const inLocation = (effect: Native) => host.runtime.runPromise(Effect.gen(function* (): Native {
    const locations = yield* LocationServiceMap.Service;
    return yield* effect.pipe(Effect.provide(locations.get(Location.Ref.make({ directory: options.cwd }))));
  }));
  async function command(body: Native) {
    if (!accepting || !body || typeof body.callId !== 'string' || body.callId.length > 128 || !/^ses_[A-Za-z0-9_-]+$/.test(body.sessionId) || !Array.isArray(body.argv) || !body.argv.length || body.argv.length > 128 || body.argv.some((arg: unknown) => typeof arg !== 'string' || arg.length > 16000 || arg.includes(String.fromCharCode(0))) || !body.environment || typeof body.environment !== 'object' || !body.secrets || typeof body.secrets !== 'object' || process.platform === 'win32') throw Error('Invalid native command');
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const prior = commands.prepare('SELECT fingerprint,result FROM invocation WHERE id=?').get(body.callId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Native command identity conflict'); return prior.result ? JSON.parse(String(prior.result)) : { status: 'pending' }; }
    for (const value of Object.values(body.secrets)) if (typeof value === 'string' && value) privateValues[createHash('sha256').update(value).digest('hex')] = value;
    commands.prepare('INSERT INTO invocation VALUES (?,?,NULL)').run(body.callId, fingerprint);
    reserve('skill', body.callId, body.sessionId);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const invocation = { command: body.argv.map(quote).join(' '), cwd: options.projectPath, environment: body.environment, dispatched: false };
    const effect = Effect.gen(function* (): Native {
      const sessions = yield* Session.Service, tools = yield* Tool.Service, agents = yield* Agent.Service;
      const session = yield* sessions.get(body.sessionId);
      if (session.location.directory !== options.cwd) throw Error('Native session ownership conflict');
      const agent = yield* agents.resolve(session.agent);
      const snapshot = yield* tools.snapshot([...(agent?.permissions ?? []), ...(session.permissions ?? [])]);
      return yield* snapshot.execute({ sessionID: session.id, agent: session.agent ?? 'build', messageID: 'msg_' + createHash('sha256').update(body.callId).digest('hex'),
        call: { id: 'skill-' + body.callId, name: 'shell', input: { command: invocation.command, description: 'Frozen skill command', timeout: 120000 } } }).pipe(Effect.provideService(CommandContext, invocation));
    });
    try {
      let value;
      try {
        // Host-invoked commands run outside the main session execution fiber.
        // Keep their native fiber owned so cancelling a pending approval also
        // interrupts the command and records its proven pre-dispatch result.
        const result = clean(await inLocation(Effect.gen(function* (): Native {
          const fiber = yield* effect.pipe(Effect.forkIn(executionScope, { startImmediately: true }));
          commandFibers.set(body.callId, fiber);
          return yield* Fiber.join(fiber).pipe(Effect.ensuring(Effect.sync(() => commandFibers.delete(body.callId))));
        })));
        value = { status: result.output?.exit === 0 ? 'completed' : 'failed', exitCode: result.output?.exit ?? null, output: result.output ?? result.content };
      } catch (error) {
        // Native permission rejection/interruption before Shell's spawn
        // boundary proves this command did not execute. Persist that result so
        // response loss can be reconciled without leaving a phantom skill.
        if (invocation.dispatched) throw error;
        value = { status: accepting ? 'failed' : 'cancelled', exitCode: null };
      }
      commands.prepare('UPDATE invocation SET result=? WHERE id=?').run(JSON.stringify(value), body.callId);
      terminal('skill', body.callId, value.status, value.exitCode); return value;
    } catch { terminal('skill', body.callId, 'unknown'); throw Error('Native command outcome unknown'); }
  }
  return {
    orphan() { accepting = false; },
    overrides: [CrossSpawnSpawner.node.replace(trackedSpawner), Job.node.replace(trackedJobs), Shell.node.replace(trackedShell), PluginHooks.node.replace(frozenHooks), ConfigPluginSource.node.replace(restrictedSources), Mcp.node.replace(restrictedMcp), Tool.node.replace(trackedTools), Session.node.replace(trackedSessions), pty.override, persistentPty.override, projectOperations.override], plugins: [plugin],
    attach(value: Native) { host = value; },
    async request(method: string, path: string, body: Native): Promise<unknown> {
      if (path === '/api/workgraph/ready' && method === 'POST') {
        await inLocation(Effect.gen(function* (): Native {
          const config = yield* Config.Service, mcp = yield* Mcp.Service, tools = yield* Tool.Service;
          yield* (yield* McpTool.Service).flush;
          const entries = yield* config.entries();
          const expected = new Map();
          for (const entry of entries) if (entry.type === 'document') for (const [name, server] of Object.entries(entry.info.mcp?.servers ?? {})) expected.set(name, server);
          for (let attempt = 0; attempt < 500; attempt++) {
            const servers = yield* mcp.servers();
            if (servers.some((server: Native) => ['failed', 'needs_auth'].includes(server.status.status))) throw Error('Native MCP is unavailable or needs authentication');
            const ready = [...expected].every(([name, config]: Native) => config.disabled || servers.some((server: Native) => server.name === name && server.status.status === 'connected'));
            if (ready) {
              const nativeTools = yield* mcp.tools(), registered = yield* tools.list();
              if (nativeTools.every((tool: Native) => registered.some((entry: Native) => entry.id === McpTool.name(tool.server, tool.name)))) return;
            }
            yield* Effect.sleep('20 millis');
          }
          throw Error('Native MCP activation timed out');
        }));
        return { ready: true };
      }
      if (path === '/api/workgraph/state' && method === 'GET') {
        journal.settleUnboundShells();
        return { instanceId: options.instanceId, runId: options.runId, attemptId: options.attemptId, accepting, pendingBackground: await inLocation(Effect.gen(function* (): Native { return (yield* (yield* Job.Service).pendingBackground).length; })), actions: journal.list().map(action => ({ ...action, nativeId: journal.nativeId(action.kind, action.id) })) };
      }
      if (path === '/api/workgraph/cancel' && method === 'POST') {
        accepting = false;
        await inLocation(Effect.gen(function* (): Native {
          const jobs = yield* Job.Service, shells = yield* Shell.Service;
          for (const fiber of auxiliary.values()) yield* Fiber.interrupt(fiber);
          if (body?.preserveHolds !== true) { paused = false; for (const action of journal.list().filter(action => action.id.startsWith('hold:') && action.phase === 'running')) terminal('plugin', action.id, 'cancelled'); }
          yield* pty.cancel;
          yield* persistentPty.cancel;
          // remove() deletes observation and unblocks waiters; it does NOT
          // terminate a shell. Drive native timeout and await actual exit before
          // cancelling the Job whose finalizer removes the native shell record.
          for (const action of journal.list().filter(action => action.kind === 'shell' && !['completed', 'failed', 'cancelled'].includes(action.phase))) {
            const id = journal.nativeId(action.kind, action.id);
            if (id) { yield* shells.timeout(id, 1).pipe(Effect.ignore); yield* shells.wait(id).pipe(Effect.ignore); }
          }
          if (posixGroups) for (const action of journal.list().filter(action => ['shell', 'process'].includes(action.kind) && action.pid && !['completed', 'failed', 'cancelled'].includes(action.phase))) {
            yield* Effect.tryPromise(async () => {
              if (!await openCodeGroupRunning(action.pid!)) return;
              for (const member of journal.list().filter(member => ['shell', 'process'].includes(member.kind) && member.pid === action.pid && !['completed', 'failed', 'cancelled'].includes(member.phase))) stoppingActions.add(member.id);
              const evidence = journal.shellProcess(action.id);
              if (evidence) await stopObservedOpenCodeShellGroup(evidence);
              else await stopOpenCodeNativeProcessGroup(options.instanceId, action.pid!);
            }).pipe(Effect.catchCause(() => Effect.sync(() => terminal(action.kind, action.id, 'unknown'))));
          }
          for (const fiber of commandFibers.values()) yield* Fiber.interrupt(fiber);
          for (const action of journal.list().filter(action => !['completed', 'failed', 'cancelled'].includes(action.phase))) {
            const id = journal.nativeId(action.kind, action.id);
            if (action.kind === 'plugin' && action.id.startsWith('job:') && id) yield* jobs.cancel(id);
          }
          const sessions = yield* Session.Service;
          const listed = yield* sessions.list({ limit: 2048 });
          if (listed.data.length >= 2048) throw Error('Native cancellation session budget');
          const owned = new Set(journal.list().filter(action => action.kind === 'session').map(action => action.id));
          for (let pass = 0; pass < listed.data.length; pass++) for (const item of listed.data) if (item.parentID && owned.has(item.parentID)) owned.add(item.id);
          if (listed.data.some((item: Native) => item.location.directory !== options.cwd || !owned.has(item.id))) throw Error('Unowned native session');
          for (const item of listed.data) {
            if (!journal.list().some(action => action.kind === 'session' && action.id === item.id)) journal.register({ kind: 'session', id: item.id, parentId: item.parentID });
            yield* sessions.interrupt(item.id, { resume: false });
            // Interrupt stops the execution fiber, but deliberately leaves
            // queued input and late Job notifications parked. Cancel those
            // native inbox entries as well; an idle session with pending input
            // is not drained. Repeated reconciliation catches settlement races.
            for (const entry of yield* sessions.inbox(item.id)) yield* sessions.cancelInbox({ sessionID: item.id, inboxID: entry.id }).pipe(Effect.ignore);
          }
        })); return { accepted: true };
      }
      if (path === '/api/workgraph/command' && method === 'POST') return command(body);
      if (path === '/api/workgraph/session-control' && method === 'POST') {
        if (!body || !/^[A-Za-z0-9_-]{1,128}$/.test(body.callId) || !['session.pause', 'session.resume'].includes(body.type) || !journal.list().some(action => action.kind === 'session' && action.id === body.sessionId && !action.parentId)) throw Error('Invalid session control');
        const key = 'session-control:' + body.callId, fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = commands.prepare('SELECT fingerprint,result FROM invocation WHERE id=?').get(key);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Session control identity conflict'); return prior.result ? JSON.parse(String(prior.result)) : { status: 'pending' }; }
        if (projectBusy || !journal.list().some(action => action.id.startsWith('hold:') && action.phase === 'running') || body.type === 'session.pause' && !accepting || body.type === 'session.resume' && !paused) throw Error('Session control requires an owned busy-period hold');
        commands.prepare('INSERT INTO invocation VALUES(?,?,NULL)').run(key, fingerprint);
        if (body.type === 'session.pause') {
          await this.request('POST', '/api/workgraph/cancel', { preserveHolds: true });
          for (let pass = 0; pass < 500; pass++) {
            const settled = await inLocation(Effect.gen(function* (): Native { return (yield* (yield* Session.Service).active).size === 0; }));
            const unresolved = journal.list().some(action => action.kind !== 'session' && action.kind !== 'process' && !action.id.startsWith('hold:') && !['completed', 'failed', 'cancelled'].includes(action.phase));
            if (settled && !unresolved) { paused = true; break; }
            await new Promise(done => setTimeout(done, 10));
          }
          if (!paused) throw Error('Session pause has not settled');
        } else {
          accepting = true; paused = false; reserve('plugin', key, body.sessionId);
          await inLocation(Effect.gen(function* (): Native {
            const sessions = yield* Session.Service;
            if (!executionScope) throw Error('Original execution scope is unavailable');
            yield* sessions.resume(body.sessionId).pipe(Effect.onExit((exit: Native) => Effect.sync(() => terminal('plugin', key, Exit.isSuccess(exit) ? 'completed' : 'failed'))), Effect.forkIn(executionScope, { startImmediately: true }));
          }));
        }
        const result = { status: 'completed', result: body.type === 'session.pause' ? { paused: true } : { resumed: true, sessionId: body.sessionId } };
        commands.prepare('UPDATE invocation SET result=? WHERE id=?').run(JSON.stringify(result), key); return result;
      }
      if (path === '/api/workgraph/hold' && method === 'POST') {
        if (!body || !accepting || !/^[A-Za-z0-9_-]{1,128}$/.test(body.callId) || !['session.hold', 'session.release'].includes(body.type)) throw Error('Invalid busy-period hold');
        const id = 'hold:' + body.callId, prior = journal.list().find(action => action.kind === 'plugin' && action.id === id);
        if (body.type === 'session.hold') { if (!prior) reserve('plugin', id); else if (prior.phase !== 'running') throw Error('Hold already released'); return { held: true }; }
        if (!prior) throw Error('Unowned hold'); terminal('plugin', id, 'completed'); return { released: true };
      }
      if (path === '/api/workgraph/project-operation' && method === 'POST') {
        if (!accepting || !body || !/^[A-Za-z0-9_-]{1,128}$/.test(body.callId)) throw Error('Invalid project operation');
        const key = 'project-operation:' + body.callId, fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = commands.prepare('SELECT fingerprint,result FROM invocation WHERE id=?').get(key);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Project operation identity conflict'); return prior.result ? JSON.parse(String(prior.result)) : { status: 'pending' }; }
        if (projectBusy) throw Error('Another project operation is active');
        projectBusy = true; commands.prepare('INSERT INTO invocation VALUES (?,?,NULL)').run(key, fingerprint); reserve('plugin', key);
        try {
          let value;
          try { value = clean(await inLocation(projectOperations.request(body))); }
          catch { value = { blocked: true }; }
          const result = { status: 'completed', result: value };
          commands.prepare('UPDATE invocation SET result=? WHERE id=?').run(JSON.stringify(result), key); terminal('plugin', key, 'completed'); return result;
        } finally { projectBusy = false; }
      }
      if (path === '/api/workgraph/pty' && method === 'POST') {
        const service = body?.type?.startsWith('persistentPty.') ? persistentPty : pty;
        if (body?.type === 'pty.read' || body?.type === 'persistentPty.read') return clean(await inLocation(service.request(body)));
        if (!body || !/^[A-Za-z0-9_-]{1,128}$/.test(body.callId)) throw Error('Invalid PTY identity');
        const key = 'pty-operation:' + body.callId, fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = commands.prepare('SELECT fingerprint,result FROM invocation WHERE id=?').get(key);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('PTY identity conflict'); return prior.result ? JSON.parse(String(prior.result)) : { status: 'pending' }; }
        // Deterministic permission/input/ownership rejection is not unknown
        // native work. Keep it outside the durable side-effect reservation.
        const unsupported = await inLocation(service.preflight(body));
        if (unsupported) {
          const result = { status: 'completed', result: unsupported };
          commands.prepare('INSERT INTO invocation VALUES (?,?,?)').run(key, fingerprint, JSON.stringify(result));
          return result;
        }
        commands.prepare('INSERT INTO invocation VALUES (?,?,NULL)').run(key, fingerprint); reserve('plugin', key);
        try {
          const result = { status: 'completed', result: clean(await inLocation(service.request(body))) };
          commands.prepare('UPDATE invocation SET result=? WHERE id=?').run(JSON.stringify(result), key); terminal('plugin', key, 'completed'); return result;
        } catch { terminal('plugin', key, 'unknown'); throw Error('PTY operation outcome unknown'); }
      }
      if (path === '/api/workgraph/continue' && method === 'POST') {
        if (!body || !/^[A-Za-z0-9_-]{1,128}$/.test(body.callId) || typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 65536 || !journal.list().some(action => action.kind === 'session' && action.id === body.sessionId && !action.parentId)) throw Error('Invalid owned continuation');
        const key = 'continue:' + body.callId, fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = commands.prepare('SELECT fingerprint,result FROM invocation WHERE id=?').get(key);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Continuation identity conflict'); return prior.result ? JSON.parse(String(prior.result)) : { status: 'pending' }; }
        if (accepting) throw Error('Previous busy period is not sealed');
        journal.assertDrained();
        commands.prepare('INSERT INTO invocation VALUES (?,?,NULL)').run(key, fingerprint);
        journal.beginContinuation(body.sessionId); accepting = true;
        try {
          await inLocation(Effect.gen(function* (): Native {
            const mcp = yield* Mcp.Service;
            for (const name of reconnectMcp) yield* mcp.connect(name);
          }));
          await this.request('POST', '/api/workgraph/ready', undefined);
          const inputId = 'msg_' + createHash('sha256').update(key).digest('hex').slice(0, 40);
          await inLocation(Effect.gen(function* (): Native { yield* (yield* Session.Service).prompt({ sessionID: body.sessionId, id: inputId, text: body.text, delivery: 'steer' }); }));
          const result = { status: 'completed', accepted: true, inputId };
          commands.prepare('UPDATE invocation SET result=? WHERE id=?').run(JSON.stringify(result), key); return result;
        } catch { throw Error('Owned continuation outcome unknown'); }
      }
      if (path === '/api/workgraph/fork' && method === 'POST') {
        if (!accepting || !body || typeof body.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.callId) || typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 65536 || body.before !== undefined && !/^msg_[A-Za-z0-9_-]+$/.test(body.before)) throw Error('Invalid owned fork');
        const source = journal.list().find(action => action.kind === 'session' && action.id === body.sessionId);
        if (!source) throw Error('Unowned native source');
        const key = 'fork:' + body.callId, fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const prior = commands.prepare('SELECT fingerprint,result FROM invocation WHERE id=?').get(key);
        if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Native fork identity conflict'); return prior.result ? JSON.parse(String(prior.result)) : { status: 'pending' }; }
        commands.prepare('INSERT INTO invocation VALUES (?,?,NULL)').run(key, fingerprint);
        reserve('plugin', key, body.sessionId);
        try {
          const value = await inLocation(Effect.gen(function* (): Native {
            const sessions = yield* Session.Service;
            const fork = yield* sessions.fork({ sessionID: body.sessionId, ...(body.before ? { before: body.before } : {}) });
            journal.register({ kind: 'session', id: fork.id, parentId: body.sessionId });
            journal.observe(options.instanceId, 'session', fork.id, 'running');
            const inputId = 'msg_' + createHash('sha256').update(key).digest('hex').slice(0, 40);
            // The fork remains in this frozen Run/attempt. Its output never
            // publishes independently and its lifetime participates in drain.
            yield* sessions.prompt({ sessionID: fork.id, id: inputId, text: body.text, delivery: 'steer' });
            return { accepted: true, status: 'completed', sessionId: fork.id, inputId };
          }));
          commands.prepare('UPDATE invocation SET result=? WHERE id=?').run(JSON.stringify(value), key);
          terminal('plugin', key, 'completed'); return value;
        } catch { terminal('plugin', key, 'unknown'); throw Error('Owned fork outcome unknown'); }
      }
      if (path === '/api/workgraph/seal' && method === 'POST') {
        // A background notification may be admitted between the host's
        // separate Session and Job reads. Verify the barrier inside the native
        // instance, with active checked last, before closing tool admission.
        const sealed = await inLocation(Effect.gen(function* (): Native {
          if ((yield* (yield* Job.Service).pendingBackground).length) return false;
          const sessions = yield* Session.Service;
          for (const action of journal.list().filter(action => action.kind === 'session')) {
            const value = yield* sessions.get(action.id);
            if ((!['succeeded', 'failed', 'interrupted'].includes(value.outcome) && action.phase !== 'cancelled') || (yield* sessions.inbox(action.id)).length) return false;
          }
          if (journal.list().some(action => !['session', 'process'].includes(action.kind) && !['completed', 'failed', 'cancelled'].includes(action.phase))) return false;
          const active = yield* sessions.active;
          if (active.size) return false;
          accepting = false; return true;
        }));
        if (!sealed) return { instanceId: options.instanceId, sealed: false };
        await inLocation(persistentPty.seal);
        await inLocation(Effect.gen(function* (): Native {
          const mcp = yield* Mcp.Service;
          for (const server of yield* mcp.servers()) {
            if (server.status.status === 'connected') reconnectMcp.add(server.name);
            yield* mcp.disconnect(server.name).pipe(Effect.ignore);
          }
        }));
        return { instanceId: options.instanceId, sealed: true };
      }
      if (path === '/api/workgraph/drain' && method === 'POST') {
        accepting = false;
        await this.request('POST', '/api/workgraph/cancel', undefined);
        await this.request('POST', '/api/workgraph/seal', undefined);
        await inLocation(Effect.gen(function* (): Native {
          const sessions = yield* Session.Service;
          const listed = yield* sessions.list({ limit: 2048 });
          if (listed.data.length >= 2048) throw Error('Native recovery session budget');
          const owned = new Set(journal.list().filter(action => action.kind === 'session').map(action => action.id));
          for (let pass = 0; pass < listed.data.length; pass++) for (const item of listed.data) if (item.parentID && owned.has(item.parentID)) owned.add(item.id);
          if (listed.data.some((item: Native) => item.location.directory !== options.cwd || !owned.has(item.id))) throw Error('Unowned native session');
          for (const item of listed.data) {
            if (!journal.list().some(action => action.kind === 'session' && action.id === item.id)) journal.register({ kind: 'session', id: item.id, parentId: item.parentID });
            yield* sessions.interrupt(item.id, { resume: false });
          }
          const active = yield* sessions.active;
          for (const item of listed.data) {
            const value = yield* sessions.get(item.id);
            const inbox = yield* sessions.inbox(item.id);
            // A declined tool can leave native execution suspended without an
            // idle outcome. After explicit interruption, native inactivity and
            // an empty inbox confirm cancellation of this session; independent
            // actions still have to drain through their own evidence.
            if (!active.has(item.id) && inbox.length === 0) terminal('session', item.id, value.outcome === 'succeeded' ? 'completed' : value.outcome === 'failed' ? 'failed' : 'cancelled');
          }
        }));
        const pending = await inLocation(Effect.gen(function* (): Native { return (yield* (yield* Job.Service).pendingBackground).length; }));
        journal.settleUnboundShells();
        return { instanceId: options.instanceId, drained: !journal.unresolved && pending === 0 };
      }
      if (path === '/api/workgraph/shutdown' && method === 'POST') {
        if (accepting) throw Error('Native instance still accepting work'); journal.assertDrained();
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 25);
        return { instanceId: options.instanceId, drained: true };
      }
      if (path.startsWith('/api/workgraph/command/') && method === 'GET') {
        const row = commands.prepare('SELECT result FROM invocation WHERE id=?').get(decodeURIComponent(path.slice('/api/workgraph/command/'.length)));
        return !row ? { status: 'unknown' } : row.result ? JSON.parse(String(row.result)) : { status: 'pending' };
      }
      throw Error('Private native operation unavailable');
    },
    close() { commands.close(); journal.close(); },
  };
}
