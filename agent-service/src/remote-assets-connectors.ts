import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataSource, DataSourceCredentials, RemoteEntry, RemoteFileVersion } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { connectRemoteSsh, DataSourceHostTrust } from './remote-assets-security.js';
import type { RemoteSshConnection, RemoteSftpClient, RemoteSftpStats, RemoteSftpEntry } from './remote-assets-security.js';

export const remoteFailure = (message: string): never => { throw new ServiceError('CONFLICT', message); };
export function remotePath(input: unknown, allowRoot = true): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f\\]/.test(input) || input.startsWith('/') || input.split('/').some(p => p === '..' || p === '.')) throw new ServiceError('INVALID_REQUEST', 'Invalid remote relative path.');
  if ((!allowRoot && !input) || (input && input.split('/').some(p => !p))) throw new ServiceError('INVALID_REQUEST', 'Invalid remote relative path.');
  return input;
}
const within = (root: string, path: string) => path === root || path.startsWith(root === '/' ? '/' : root + '/');
const quote = (input: string) => "'" + input.replaceAll("'", "'\"'\"'") + "'";
const commandQuote = (input: string) => process.platform === 'win32' ? '"' + input.replaceAll('"', '\\"') + '"' : quote(input);
export interface RemotePinnedFile { version: RemoteFileVersion; path: string }
export interface RemoteConnector { list(path: string): Promise<RemoteEntry[]>; pin(path: string, destination: string, maxBytes: number, original?: RemoteFileVersion): Promise<RemotePinnedFile>; close(): void }
type ConnectionOptions = { credentials: DataSourceCredentials; trust: DataSourceHostTrust; signal: AbortSignal; cacheRoot: string; progress?: (received: number, total: number | null) => void; keyPath?: string; gitCaFile?: string };
// Requests share a bare repository, so every cache writer uses the same queue.
const gitCacheWrites = new Map<string, Promise<void>>();

async function spool(chunks: AsyncIterable<Uint8Array>, destination: string | undefined, maxBytes: number, signal: AbortSignal, progress?: (received: number) => void): Promise<{ sha256: string; bytes: number }> {
  const file = destination ? await open(destination, 'wx', 0o600) : undefined;
  let bytes = 0, complete = false; const hash = createHash('sha256');
  try {
    for await (const chunk of chunks) { signal.throwIfAborted(); bytes += chunk.length; if (bytes > maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Remote file exceeds the 300 MiB import limit.'); hash.update(chunk); if (file) await file.writeFile(chunk); progress?.(bytes); }
    signal.throwIfAborted(); if (file) { await file.sync(); await file.chmod(0o400); } complete = true; return { sha256: hash.digest('hex'), bytes };
  } finally { await file?.close(); if (!complete && destination) await rm(destination, { force: true }); }
}

class GitConnector implements RemoteConnector {
  readonly root: string;
  private client?: RemoteSshConnection;
  private server?: ReturnType<typeof createServer>;
  private env: NodeJS.ProcessEnv;
  private commit = '';
  private askpassFile?: string;
  private readonly sockets = new Set<import('node:net').Socket>();
  private readonly config: Extract<DataSource['config'], { kind: 'git' }>;
  constructor(readonly source: DataSource, readonly options: ConnectionOptions) {
    if (source.config.kind !== 'git') throw Error(); this.config = source.config;
    this.root = join(options.cacheRoot, source.id + '-' + source.locationRevision);
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|SSH_ASKPASS|OPENWORKGRAPH_GIT_)/.test(key)));
    if (options.gitCaFile) this.env['GIT_SSL_CAINFO'] = options.gitCaFile;
    Object.assign(this.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_SSH_VARIANT: 'ssh', GIT_NO_REPLACE_OBJECTS: '1' });
  }
  private args(args: string[]): string[] { return ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'http.followRedirects=false', '--git-dir=' + this.root, ...args]; }
  private process(args: string[]) {
    this.options.signal.throwIfAborted();
    const child = spawn('git', this.args(args), { env: this.env, stdio: ['ignore', 'pipe', 'pipe'], signal: this.options.signal, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 120_000); timer.unref();
    let authenticationFailed = false; child.stderr.on('data', (chunk: Buffer) => { if (/authentication failed|could not read Username|could not read Password|permission denied|HTTP[^\n]*40[13]/i.test(chunk.toString())) authenticationFailed = true; });
    const done = new Promise<void>((resolve, reject) => { child.on('error', () => reject(new ServiceError('CONFLICT', 'Git is unavailable or the operation was cancelled.'))); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new ServiceError('CONFLICT', authenticationFailed ? 'Git authentication failed. Check data source credentials.' : 'Git read failed. Check the repository, branch, credentials and host trust in settings.')); }); });
    void done.catch(() => {}); return { child, done };
  }
  private async run(args: string[], max = 8 * 1024 * 1024): Promise<Buffer> {
    const { child, done } = this.process(args); const chunks: Buffer[] = []; let size = 0;
    for await (const part of child.stdout) { size += part.length; if (size > max) { child.kill(); remoteFailure('Git response is too large.'); } chunks.push(part); } await done; return Buffer.concat(chunks);
  }
  private async writeCache<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.options.signal; signal.throwIfAborted();
    const previous = gitCacheWrites.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    gitCacheWrites.set(this.root, tail);
    // A cancelled waiter must not remove the queue while an earlier writer runs.
    void tail.then(() => { if (gitCacheWrites.get(this.root) === tail) gitCacheWrites.delete(this.root); });
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([previous, cancelled]); signal.throwIfAborted(); return await work(); }
    finally { signal.removeEventListener('abort', abort); release(); }
  }
  private async bridge(): Promise<void> {
    const config = this.config; let repository = '';
    if (config.auth === 'key') {
      const url = new URL(config.url); repository = decodeURIComponent(url.pathname);
      this.client = await connectRemoteSsh({ host: url.hostname, port: Number(url.port || 22), username: decodeURIComponent(url.username || 'git'), auth: 'key', credentials: this.options.credentials, trust: this.options.trust, sourceId: this.source.id, revision: this.source.revision, signal: this.options.signal, ...(this.options.keyPath ? { keyPath: this.options.keyPath } : {}) });
    }
    const secret = randomUUID();
    this.server = createServer(socket => {
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.on('error', () => {});
      let input = Buffer.alloc(0);
      const header = (chunk: Buffer) => {
        input = Buffer.concat([input, chunk]); if (input.length > 8192) { socket.destroy(); return; }
        const end = input.indexOf(10); if (end < 0) return; socket.pause(); socket.removeListener('data', header);
        try {
          const request = JSON.parse(input.subarray(0, end).toString()); if (request.secret !== secret) throw Error();
          if (request.mode === 'askpass' && config.auth === 'token') { socket.end((/username/i.test(String(request.prompt)) ? 'oauth2' : this.options.credentials.token ?? '') + '\n'); return; }
          if (request.mode !== 'ssh' || !this.client) throw Error();
          this.client.exec('git-upload-pack ' + quote(repository), (error, stream) => {
            if (error) { socket.destroy(); return; }
            stream.stderr.resume(); if (end + 1 < input.length) stream.write(input.subarray(end + 1));
            socket.pipe(stream); stream.pipe(socket); socket.resume(); stream.on('error', () => socket.destroy()); stream.on('exit', code => { if (code) socket.destroy(); });
          });
        } catch { socket.destroy(); }
      }; socket.on('data', header);
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw Error();
    Object.assign(this.env, { OPENWORKGRAPH_GIT_BRIDGE_PORT: String(address.port), OPENWORKGRAPH_GIT_BRIDGE_KEY: secret });
    const bridge = commandQuote(process.execPath) + ' ' + commandQuote(fileURLToPath(new URL('./remote-git-bridge.js', import.meta.url)));
    if (config.auth === 'key') this.env['GIT_SSH_COMMAND'] = bridge + ' ssh';
    else {
      await mkdir(this.options.cacheRoot, { recursive: true, mode: 0o700 });
      this.askpassFile = join(this.options.cacheRoot, 'askpass-' + randomUUID() + (process.platform === 'win32' ? '.cmd' : '.sh'));
      await writeFile(this.askpassFile, process.platform === 'win32' ? '@' + bridge + ' askpass %*\r\n' : '#!/bin/sh\nexec ' + bridge + ' askpass "$@"\n', { mode: 0o700, flag: 'wx' });
      this.env['GIT_ASKPASS'] = this.askpassFile;
    }
  }
  private async initialize(refresh: boolean): Promise<void> {
    if (refresh && !this.server && this.config.auth !== 'public') await this.bridge();
    await this.writeCache(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.run(['init', '--bare']);
      if (refresh) {
        await this.run(['fetch', '--no-tags', '--no-recurse-submodules', '--force', this.config.url, '+refs/heads/' + this.config.branch + ':refs/heads/current']);
        this.commit = (await this.run(['rev-parse', '--verify', 'refs/heads/current^{commit}'])).toString().trim();
      }
    });
  }
  private async entry(path: string): Promise<{ mode: string; type: string; oid: string }> {
    if (!path) return { mode: '040000', type: 'tree', oid: (await this.run(['rev-parse', this.commit + '^{tree}'])).toString().trim() };
    const result = (await this.run(['ls-tree', '-z', this.commit, '--', ':(literal)' + path])).toString('utf8').split('\0').filter(Boolean);
    const line = result.find(item => item.slice(item.indexOf('\t') + 1) === path); if (!line) remoteFailure('Remote entry is missing. Select the file again.');
    const [mode, type, oid] = line!.slice(0, line!.indexOf('\t')).split(' '); return { mode: mode!, type: type!, oid: oid! };
  }
  private async resolveWithin(path: string, configured: string): Promise<{ path: string; mode: string; type: string; oid: string }> {
    const visited = new Set<string>();
    for (let loops = 0; loops < 40; loops++) {
      if (!within(configured, path) && configured) remoteFailure('Symbolic link is outside the configured root.');
      const parts = path ? path.split('/') : []; let redirected = false;
      for (let i = 0; i < parts.length; i++) {
        const prefix = parts.slice(0, i + 1).join('/'), entry = await this.entry(prefix);
        if (entry.mode === '120000') {
          if (visited.has(prefix)) remoteFailure('Remote symbolic link cycle.'); visited.add(prefix);
          const target = (await this.run(['cat-file', 'blob', entry.oid], 8192)).toString('utf8');
          if (target.startsWith('/') || /[\x00-\x1f\\]/.test(target)) remoteFailure('Unsupported remote symbolic link.');
          path = posix.normalize(posix.join(posix.dirname(prefix), target, ...parts.slice(i + 1)));
          if (path === '.') path = '';
          if (path.startsWith('../') || path === '..' || (configured && !within(configured, path))) remoteFailure('Symbolic link is outside the configured root.');
          redirected = true; break;
        }
        if (i < parts.length - 1 && entry.type !== 'tree') remoteFailure('Remote path is not a directory.');
      }
      if (!redirected) return { path, ...await this.entry(path) };
    } return remoteFailure('Too many remote symbolic links.');
  }
  private async resolve(relative: string): Promise<{ path: string; mode: string; type: string; oid: string }> {
    const root = await this.resolveWithin(this.config.root, '');
    if(root.type !== 'tree') remoteFailure('Configured root is not a directory.');
    return this.resolveWithin(root.path + (relative ? (root.path ? '/' : '') + relative : ''), root.path);
  }
  async list(path: string): Promise<RemoteEntry[]> {
    remotePath(path); await this.initialize(true); const dir = await this.resolve(path); if (dir.type !== 'tree') remoteFailure('Configured path is not a directory.');
    const rows = (await this.run(['ls-tree', '-z', '-l', dir.oid])).toString('utf8').split('\0').filter(Boolean);
    const entries: RemoteEntry[] = [];
    for (const row of rows) {
      const tab = row.indexOf('\t'), name = row.slice(tab + 1), relative = path ? path + '/' + name : name;
      try { remotePath(relative, false); const item = await this.resolve(relative); if (item.type !== 'tree' && item.type !== 'blob') remoteFailure('Git submodule contents are unavailable.'); const bytes = item.type === 'blob' ? Number((await this.run(['cat-file', '-s', item.oid])).toString()) : null; entries.push({ name, path: relative, kind: item.type === 'tree' ? 'directory' : 'file', bytes }); }
      catch (error) { entries.push({ name, path: relative, kind: 'unavailable', bytes: null, error: error instanceof ServiceError ? error.message : 'Remote entry is unavailable.' }); }
    } return entries;
  }
  async pin(path: string, destination: string, maxBytes: number, original?: RemoteFileVersion): Promise<RemotePinnedFile> {
    remotePath(path, false); if (original && original.kind !== 'git') remoteFailure('Original version is unavailable. Select the file again.');
    await this.initialize(!original);
    if (original?.kind === 'git') {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(original.commit)) remoteFailure('Original version is unavailable. Select the file again.');
      this.commit = original.commit;
      try { await this.run(['cat-file','-e',this.commit+'^{commit}']); }
      catch {
        if (!this.server && this.config.auth !== 'public') await this.bridge();
        try { await this.writeCache(() => this.run(['fetch','--no-tags','--no-recurse-submodules',this.config.url,this.commit])); }
        catch(error) { if(error instanceof ServiceError && error.message === 'Git authentication failed. Check data source credentials.') throw error; remoteFailure('Original version is unavailable. Select the file again.'); }
      }
    }
    const entry = await this.resolve(path); if (entry.type !== 'blob' || entry.mode === '160000') remoteFailure('Select a readable file.');
    await this.writeCache(() => this.run(['update-ref', 'refs/remote-assets/pinned/' + this.commit, this.commit]));
    const total = Number((await this.run(['cat-file', '-s', entry.oid])).toString()); if (total > maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Remote file exceeds the 300 MiB import limit.');
    const { child, done } = this.process(['cat-file', 'blob', entry.oid]);
    const content = await spool(child.stdout, destination, maxBytes, this.options.signal, size => this.options.progress?.(size, total)); await done;
    const version: RemoteFileVersion = { kind: 'git', commit: this.commit, blob: entry.oid, ...content };
    if (original && (version.sha256 !== original.sha256 || version.bytes !== original.bytes || entry.oid !== (original as Extract<RemoteFileVersion, { kind: 'git' }>).blob)) remoteFailure('Original version is unavailable. Select the file again.');
    if (content.bytes < 1024) { const file = await open(destination, 'r'); try { if ((await file.readFile()).toString().startsWith('version https://git-lfs.github.com/spec/v1')) remoteFailure('Git LFS content is unavailable from this source.'); } finally { await file.close(); } }
    return { path: destination, version };
  }
  close(): void { this.client?.end(); for (const socket of this.sockets) socket.destroy(); this.server?.close(); if (this.askpassFile) void rm(this.askpassFile, { force: true }).catch(() => {}); }
}

class SftpConnector implements RemoteConnector {
  private client?: RemoteSshConnection; private sftp?: RemoteSftpClient; private root = '';
  constructor(readonly source: DataSource, readonly options: ConnectionOptions) {}
  private async initialize(): Promise<void> {
    if (this.sftp) return; const config = this.source.config; if (config.kind !== 'sftp') throw Error();
    this.client = await connectRemoteSsh({ ...config, credentials: this.options.credentials, trust: this.options.trust, sourceId: this.source.id, revision: this.source.revision, signal: this.options.signal, ...(this.options.keyPath ? { keyPath: this.options.keyPath } : {}) });
    this.sftp = await new Promise((resolve, reject) => this.client!.sftp((err, sftp) => err ? reject(err) : resolve(sftp)));
    this.root = await this.realpath(config.root);
    if (!(await this.info(this.root)).isDirectory()) remoteFailure('Configured root is not a directory.');
  }
  private realpath(path: string): Promise<string> { return new Promise((resolve, reject) => this.sftp!.realpath(path, (err, result) => err ? reject(new ServiceError('CONFLICT', 'Remote path is missing, unreadable, or has a broken/cyclic link.')) : resolve(result))); }
  private info(path: string): Promise<RemoteSftpStats> { return new Promise((resolve, reject) => this.sftp!.stat(path, (err, result) => err ? reject(new ServiceError('CONFLICT', 'Remote file is missing or unreadable.')) : resolve(result))); }
  private async resolve(path: string): Promise<string> {
    remotePath(path); await this.initialize(); const actual = await this.realpath(posix.join(this.root, path));
    if (!within(this.root, actual)) remoteFailure('Symbolic link is outside the configured root.'); return actual;
  }
  async list(path: string): Promise<RemoteEntry[]> {
    const actual = await this.resolve(path); if (!(await this.info(actual)).isDirectory()) remoteFailure('Remote path is not a directory.');
    const rows = await new Promise<RemoteSftpEntry[]>((resolve, reject) => this.sftp!.readdir(actual, (err, result) => err ? reject(new ServiceError('CONFLICT', 'Remote directory cannot be read.')) : resolve(result)));
    const entries: RemoteEntry[] = [];
    for (const item of rows) {
      if (item.filename === '.' || item.filename === '..') continue; const relative = path ? path + '/' + item.filename : item.filename;
      try { remotePath(relative, false); const resolved = await this.resolve(relative), info = await this.info(resolved); if (!info.isFile() && !info.isDirectory()) remoteFailure('Unsupported remote entry.'); entries.push({ name: item.filename, path: relative, kind: info.isDirectory() ? 'directory' : 'file', bytes: info.isFile() ? info.size : null }); }
      catch (error) { entries.push({ name: item.filename, path: relative, kind: 'unavailable', bytes: null, error: error instanceof ServiceError ? error.message : 'Remote entry is unavailable.' }); }
    } return entries;
  }
  async pin(path: string, destination: string, maxBytes: number, original?: RemoteFileVersion): Promise<RemotePinnedFile> {
    if (original && original.kind !== 'sftp') remoteFailure('Original version is unavailable. Select the file again.');
    const actual = await this.resolve(path), before = await this.info(actual); if (!before.isFile()) remoteFailure('Select a readable file.');
    if (before.size > maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Remote file exceeds the 300 MiB import limit.');
    const content = await spool(this.sftp!.createReadStream(actual, { autoClose: true }), destination, maxBytes, this.options.signal, bytes => this.options.progress?.(bytes, before.size));
    const again = await this.resolve(path), after = await this.info(actual);
    if (again !== actual || before.size !== after.size || before.mtime !== after.mtime || before.mode !== after.mode || content.bytes !== before.size) remoteFailure('Remote file changed during transfer. Select the file again.');
    const check = await spool(this.sftp!.createReadStream(actual, { autoClose: true }), undefined, maxBytes, this.options.signal);
    const final = await this.info(actual);
    if (check.sha256 !== content.sha256 || check.bytes !== content.bytes || after.mtime !== final.mtime || after.size !== final.size || await this.resolve(path) !== actual) remoteFailure('Remote file changed during transfer. Select the file again.');
    if (original && (original.sha256 !== content.sha256 || original.bytes !== content.bytes)) remoteFailure('Original version is unavailable. Select the file again.');
    return { path: destination, version: { kind: 'sftp', ...content } };
  }
  close(): void { this.sftp?.end(); this.client?.end(); }
}
export function createRemoteConnector(source: DataSource, options: ConnectionOptions): RemoteConnector { return source.config.kind === 'git' ? new GitConnector(source, options) : new SftpConnector(source, options); }
export async function verifiedRemoteCache(path: string, version: RemoteFileVersion, signal: AbortSignal): Promise<boolean> {
  try { if ((await stat(path)).size !== version.bytes) return false; const result = await spool(createReadStream(path), undefined, version.bytes, signal); return result.sha256 === version.sha256 && result.bytes === version.bytes; } catch { signal.throwIfAborted(); return false; }
}
