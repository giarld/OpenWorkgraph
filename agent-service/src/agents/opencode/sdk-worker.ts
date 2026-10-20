import { OPENCODE_MINIMUM_VERSION, isSupportedOpenCodeVersion } from './version.js';

/** Runs in a private Node child with the selected native SDK installation. Native
 * service composition stays outside the host's dependency/runtime context. */
export const openCodeSdkWorkerSource = String.raw`
import { createRequire, findPackageJSON } from 'node:module';
import { readFile, open } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

const root = process.env.WORKGRAPH_OPENCODE_SDK_ROOT;
const projectPath = process.env.WORKGRAPH_OPENCODE_PROJECT;
const executionPath = process.env.WORKGRAPH_OPENCODE_CWD;
const password = process.env.OPENCODE_PASSWORD;
const OPENCODE_MINIMUM_VERSION = ${JSON.stringify(OPENCODE_MINIMUM_VERSION)};
const isSupportedOpenCodeVersion = ${isSupportedOpenCodeVersion.toString()};
let host, server, bridge, bridgeOptions;
async function privateRecord(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
try {
  if (![root, projectPath, executionPath].every(value => typeof value === 'string' && isAbsolute(value)) || !password) throw Error('private bootstrap');
  if (process.env.WORKGRAPH_OPENCODE_BRIDGE) {
    bridgeOptions = JSON.parse(process.env.WORKGRAPH_OPENCODE_BRIDGE);
    await privateRecord(join(bridgeOptions.directory, 'bootstrap.json'), { version: 1, runtime: 'sdk', instanceId: bridgeOptions.instanceId, runId: bridgeOptions.runId, attemptId: bridgeOptions.attemptId, directory: bridgeOptions.directory, cwd: executionPath, projectPath, database: process.env.OPENCODE_DB, pid: process.pid, selectionDigest: bridgeOptions.selectionDigest ?? null });
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@opencode/sdk' || !isSupportedOpenCodeVersion(manifest.version)) throw Error('native version');
  const require = createRequire(join(root, 'package.json'));
  const coreRoot = dirname(findPackageJSON('@opencode/core', pathToFileURL(join(root, 'package.json'))));
  const coreManifest = JSON.parse(await readFile(join(coreRoot, 'package.json'), 'utf8'));
  if (coreManifest.version !== manifest.version) throw Error('native dependency version');
  for (const name of ['@opencode/schema', '@opencode/server', '@opencode/util', '@opencode/plugin']) {
    const path = findPackageJSON(name, pathToFileURL(join(root, 'package.json')));
    if (JSON.parse(await readFile(path, 'utf8')).version !== manifest.version) throw Error('native dependency version');
  }
  // Published Core exports have an import condition only; createRequire.resolve
  // cannot select it. The exact native dist layout is part of this pinned bridge.
  const load = specifier => {
    if (!specifier.startsWith('@opencode/')) return import(pathToFileURL(require.resolve(specifier)).href);
    const parts = specifier.split('/'), name = parts.slice(0, 2).join('/');
    const packageRoot = dirname(findPackageJSON(name, pathToFileURL(join(root, 'package.json'))));
    return import(pathToFileURL(join(packageRoot, 'dist', parts.slice(2).join('/') + '.js')).href);
  };
  // Node's published native adapter otherwise searches PATH only, even though
  // the pinned SDK dependency already ships its platform daemon package.
  // Resolve that package inside this private worker; never change host env.
  if (!process.env.OPENCODE_PTY_BIN) {
    try { const { binaryPath } = await load('@opencode-ai/pty'); if (binaryPath) process.env.OPENCODE_PTY_BIN = binaryPath; } catch { /* Missing optional platform binary is reported by the finite terminal API. */ }
  }
  const [{ Effect, Layer }, EmbeddedHost, { Config }, { Location }, { Project }, { SessionRestart }, NativeConfig, { Bus }] = await Promise.all([
    load('effect'), import(pathToFileURL(join(root, 'dist/internal/host.js')).href), load('@opencode/core/config'), load('@opencode/core/location'),
    load('@opencode/core/project'), load('@opencode/core/session/execution/restart'), load('@opencode/schema/config'), load('@opencode/core/bus'),
  ]);
  const truthy = value => value === '1' || value?.toLowerCase() === 'true';
  const configuration = { project: !truthy(process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG),
    ...(process.env.OPENCODE_CONFIG ? { file: process.env.OPENCODE_CONFIG } : {}),
    ...(process.env.OPENCODE_CONFIG_CONTENT ? { content: process.env.OPENCODE_CONFIG_CONTENT } : {}),
  };
  if (process.env.WORKGRAPH_OPENCODE_BRIDGE) {
    const { createOpenCodeSdkBridge } = await import(pathToFileURL(join(process.env.WORKGRAPH_OPENCODE_HOST_MODULES, 'sdk-bridge.js')).href);
    bridge = await createOpenCodeSdkBridge(bridgeOptions, load);
  }
  // Execution inside the project keeps its nested native scope; external Runs
  // resolve configuration at their owning project without moving tool cwd.
  const child = relative(projectPath, executionPath);
  const configDirectory = !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep) ? executionPath : projectPath;
  // Decorate instead of rebuilding or flattening native config documents.
  const owningConfig = Config.configured(configuration).mapLayer(layer => Layer.unwrap(Effect.gen(function* () {
    const location = yield* Location.Service;
    const bus = yield* Bus.Service;
    const ownedLocation = { ...location, directory: configDirectory };
    // Config lookup uses the owner, but its updates belong to the actual Run
    // Location. Otherwise native consumers filter out config.updated and only
    // the effective documents change while agent/model/command state goes stale.
    const runBus = { ...bus, publish: (...args) => bus.publish(...args).pipe(Effect.provideService(Location.Service, location)) };
    return Layer.effect(Config.Service, Effect.gen(function* () {
      const native = yield* Config.Service;
      return { ...native, entries: () => native.entries().pipe(Effect.map(entries => {
        const warming = entries.findLast(entry => entry.type === 'document' && entry.info.warming !== undefined);
        if (bridgeOptions && warming?.info.warming) throw Error('Private Run cannot enable independent keep-alive inference');
        return entries.map(entry => {
        if (process.env.WORKGRAPH_OPENCODE_BRIDGE && JSON.parse(process.env.WORKGRAPH_OPENCODE_BRIDGE).permissionMode !== 'danger-full-access' && entry.type === 'document' && (entry.info.formatter === true || entry.info.formatter && typeof entry.info.formatter === 'object' && Object.values(entry.info.formatter).some(formatter => formatter.disabled !== true))) throw Error('Restricted Run cannot execute unaudited formatter commands');
        if (entry.type !== 'document' || !entry.info.skills) return entry;
        return new NativeConfig.Document({ ...entry, info: new NativeConfig.Info({ ...entry.info, skills: entry.info.skills.map(path =>
          path.startsWith('~/') || isAbsolute(path) || /^https?:/.test(path) ? path : resolve(configDirectory, path)) }) });
      }); })) };
    })).pipe(Layer.provide(Layer.provide(layer, Layer.merge(Layer.succeed(Location.Service, ownedLocation), Layer.succeed(Bus.Service, runBus)))));
  })));
  const owningProject = Project.node.mapLayer(layer => Layer.effect(Project.Service, Effect.gen(function* () {
    const native = yield* Project.Service;
    const project = yield* native.resolve(projectPath);
    return { ...native, resolve: directory => directory === executionPath ? Effect.succeed(project) : native.resolve(directory) };
  })).pipe(Layer.provide(layer)));
  // EmbeddedHost normally performs at-least-once restart continuity at boot.
  // Workgraph must reconcile original actions before explicitly resuming.
  const noAutomaticResume = SessionRestart.node.replace(Layer.succeed(SessionRestart.Service, { resumeSuspendedSessions: Effect.void }));
  const credentialOverrides = [];
  if (process.env.WORKGRAPH_OPENCODE_CREDENTIAL_DB) {
    const source = process.env.WORKGRAPH_OPENCODE_CREDENTIAL_DB;
    const [{ Credential }, { Database }, { Integration }, { Flock }] = await Promise.all([load('@opencode/core/credential'), load('@opencode/core/database/database'), load('@opencode/core/integration'), load('@opencode/util/flock')]);
    // Only Credential sees the device DB. Sessions, tools, permissions, native
    // storage and all other services retain this attempt's private database.
    const deviceCredentials = Credential.node.mapLayer(layer => Layer.provide(layer, Database.layer({ path: source })));
    const leasedIntegration = Integration.node.mapLayer(layer => Layer.effect(Integration.Service, Effect.gen(function* () {
      const native = yield* Integration.Service;
      return { ...native, connection: { ...native.connection, resolve: connection => Effect.scoped(Effect.gen(function* () {
        if (connection.type !== 'env') yield* Flock.effect('credential:' + connection.id, { dir: source + '.workgraph-locks', timeoutMs: 30000 });
        return yield* native.connection.resolve(connection);
      })) } };
    })).pipe(Layer.provide(layer)));
    credentialOverrides.push(Credential.node.replace(deviceCredentials), Integration.node.replace(leasedIntegration));
  }
  const program = Effect.scoped(Effect.gen(function* () {
    host = yield* Effect.acquireRelease(EmbeddedHost.create({ app: { name: 'workgraph-private', version: manifest.version },
      database: { path: process.env.OPENCODE_DB },
      models: { fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH), url: process.env.OPENCODE_MODELS_URL, file: process.env.OPENCODE_MODELS_PATH },
      config: { ...configuration, directory: process.env.OPENCODE_CONFIG_DIR },
      windows: { gitbash: process.env.OPENCODE_GIT_BASH_PATH },
      fs: { filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
        fff: process.env.OPENCODE_DISABLE_FFF === undefined ? process.platform !== 'win32' : !truthy(process.env.OPENCODE_DISABLE_FFF) },
      ...(bridge ? { plugins: bridge.plugins } : {}),
    }, { overrides: [Config.node.replace(owningConfig), Project.node.replace(owningProject), noAutomaticResume, ...credentialOverrides, ...(bridge?.overrides ?? [])] }), value => Effect.promise(value.close));
    bridge?.attach(host);
    const expected = Buffer.from('Basic ' + Buffer.from('opencode:' + password).toString('base64'));
    server = createServer(async (request, response) => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401); response.end(); return; }
      const controller = new AbortController(); let ownedBody;
      const disconnected = () => { if (!response.writableFinished) { controller.abort(); ownedBody?.destroy(); } };
      request.once('aborted', disconnected); response.once('close', disconnected);
      try {
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 16 * 1024 * 1024) throw Error('input budget'); chunks.push(chunk); }
        const method = request.method ?? 'GET';
        if (bridge && request.url?.startsWith('/api/workgraph/')) {
          const result = await bridge.request(method, new URL(request.url, 'http://opencode.local').pathname, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); return;
        }
        const nativeRequest = new Request(new URL(request.url ?? '/', 'http://opencode.local'), { method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }), signal: controller.signal });
        const result = await host.fetch(nativeRequest);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) { ownedBody = Readable.fromWeb(result.body); ownedBody.on('error', () => response.destroy()); ownedBody.pipe(response); } else response.end();
      } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
    });
    yield* Effect.acquireRelease(Effect.promise(() => new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); })),
      () => Effect.promise(() => new Promise(accept => { server.closeAllConnections(); server.close(accept); })));
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    if (bridgeOptions?.recoverable) yield* Effect.promise(() => privateRecord(join(bridgeOptions.directory, 'private-transport.json'), { version: 1, instanceId: bridgeOptions.instanceId, endpoint, password }));
    process.stdout.write(JSON.stringify({ url: endpoint }) + '\n');
    yield* Effect.callback(resume => {
      const stop = () => resume(Effect.void);
      const eof = () => { if (bridgeOptions?.recoverable) bridge.orphan(); else stop(); };
      process.stdin.resume(); process.stdin.once('end', eof); process.once('SIGTERM', stop);
      return Effect.sync(() => { process.stdin.removeListener('end', eof); process.removeListener('SIGTERM', stop); });
    });
  }));
  await Effect.runPromise(program);
} catch {
  process.stderr.write('OpenCode private SDK worker could not start or drain.\n');
  process.exitCode = 1;
} finally {
  bridge?.close();
}
`;
