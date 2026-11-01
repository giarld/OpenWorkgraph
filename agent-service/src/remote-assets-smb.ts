import { connect } from '@winlinux/smb2';
import { createAuthProvider } from '@winlinux/auth';
import { rm } from 'node:fs/promises';
import type { DataSource, RemoteEntry, RemoteFileVersion } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { remoteFailure, remotePath, spool } from './remote-assets-connectors.js';
import type { ConnectionOptions, RemoteConnector, RemotePinnedFile, RemotePreviewReader } from './remote-assets-connectors.js';

type SmbConfig = Extract<DataSource['config'], { kind: 'smb' }>;
interface SmbInfo { sizeBytes: bigint; mtime: Date; isDirectory: boolean }
interface SmbEntry extends SmbInfo { name: string; isReparsePoint: boolean }
/** Keep dependency-specific declarations out of the service's public SDK. */
export interface RemoteSmbSession {
  listShares(): Promise<{ name: string; type: string }[]>;
  list(share: string, path: string, options: { signal: AbortSignal }): Promise<SmbEntry[]>;
  stat(share: string, path: string, options: { signal: AbortSignal }): Promise<SmbInfo>;
  readRange(share: string, path: string, offset: number, length: number, options: { signal: AbortSignal }): Promise<Buffer>;
  close(): Promise<void>;
}
export async function connectRemoteSmb(config: SmbConfig, password: string): Promise<RemoteSmbSession> {
  return connect({ host: config.host, port: config.port, authProvider: createAuthProvider('ntlm'),
    credentials: { username: config.username, domain: config.domain, password }, signing: 'required',
    connectTimeoutMs: 10_000, requestTimeoutMs: 30_000 });
}

/** SMB also interprets streams, wildcards and trailing dots/spaces as aliases. */
export function smbPath(input: unknown): string {
  const path = remotePath(input);
  if (/[<>:"|?*]/.test(path) || path.split('/').some(part => /[. ]$/.test(part))) throw new ServiceError('INVALID_REQUEST', 'Invalid SMB relative path.');
  return path;
}
function smbError(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  const message = name === 'SmbAuthError' ? 'SMB authentication failed. Check data source credentials.'
    : name === 'SmbAccessDeniedError' ? 'SMB access denied. Check share and directory permissions.'
    : name === 'SmbNotFoundError' && status === 0xc00000cc ? 'SMB share was not found. Check the shared folder name.'
    : name === 'SmbNotFoundError' ? 'Remote file is missing or unreadable.'
    : name === 'SmbSigningError' || name === 'SmbEncryptionRequiredError' || name === 'SmbDialectError' ? 'SMB security negotiation failed. Check SMB 2/3 and signing support.'
    : 'SMB connection or read failed. Check the server, share and credentials.';
  // Never include raw library errors: they may retain authentication requests.
  throw new ServiceError('CONFLICT', message);
}
const same = (a: SmbInfo, b: SmbInfo) => a.sizeBytes === b.sizeBytes && a.mtime.getTime() === b.mtime.getTime() && a.isDirectory === b.isDirectory;
const changed = () => remoteFailure('Remote file changed during transfer. Select the file again.');

export class SmbConnector implements RemoteConnector {
  private session?: RemoteSmbSession;
  private sharedFolders?: Promise<string[]>;
  private closed = false;
  private readonly config: SmbConfig;
  constructor(source: DataSource, private readonly options: ConnectionOptions) {
    if (source.config.kind !== 'smb') throw Error();
    this.config = source.config;
  }
  private async call<T>(work: () => Promise<T>, signal = this.options.signal): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) remoteFailure('SMB connection or read failed. Check the server, share and credentials.');
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { const result = await Promise.race([work(), cancelled]); signal.throwIfAborted(); return result; }
    catch (error) { signal.throwIfAborted(); return smbError(error); }
    finally { signal.removeEventListener('abort', abort); }
  }
  private async connection(): Promise<RemoteSmbSession> {
    if (this.session) return this.session;
    const password = this.options.credentials.password;
    if (typeof password !== 'string') remoteFailure('Enter the SMB password in data source settings.');
    return this.call(async () => {
      const session = await (this.options.smbConnect ?? connectRemoteSmb)(this.config, password!);
      if (this.closed || this.options.signal.aborted) { await session.close().catch(() => {}); this.options.signal.throwIfAborted(); remoteFailure('SMB connection or read failed. Check the server, share and credentials.'); }
      this.session = session; return session;
    });
  }
  async shares(): Promise<string[]> {
    this.options.signal.throwIfAborted();
    if (this.closed) remoteFailure('SMB connection or read failed. Check the server, share and credentials.');
    if (!this.sharedFolders) this.sharedFolders = (async () => {
      const session = await this.connection();
      const shares = await this.call(() => session.listShares());
      return [...new Set(shares.filter(share => {
        if (share.type !== 'disk' || !share.name || share.name.includes('/')) return false;
        try { smbPath(share.name); return true; } catch { return false; }
      }).map(share => share.name))];
    })();
    return this.sharedFolders;
  }
  private async rows(share: string, path: string, signal = this.options.signal): Promise<SmbEntry[]> {
    const session = await this.connection();
    return this.call(() => session.list(share, path, { signal }), signal);
  }
  private async info(share: string, path: string, signal = this.options.signal): Promise<SmbInfo> {
    const session = await this.connection();
    return this.call(() => session.stat(share, path, { signal }), signal);
  }
  private async resolve(path: string, signal = this.options.signal): Promise<{ share: string; path: string; info: SmbInfo }> {
    signal.throwIfAborted();
    smbPath(path); const full = [this.config.root, path].filter(Boolean).join('/'); smbPath(full);
    const parts = full ? full.split('/') : [];
    let share = this.config.share;
    if (!share) {
      const requested = parts.shift();
      const selected = (await this.call(() => this.shares(), signal)).find(name => name.toLowerCase() === requested?.toLowerCase());
      if (!selected) remoteFailure('SMB share was not found. Check the shared folder name.');
      share = selected!;
    }
    let current = '';
    // Verify every component, including the configured root, without following
    // reparse points. The client does not resolve canonical symlink targets.
    for (const [index, part] of parts.entries()) {
      const rows = await this.rows(share, current, signal);
      const exact = rows.find(row => row.name === part);
      const matches = exact ? [exact] : rows.filter(row => row.name.toLowerCase() === part.toLowerCase());
      if (matches.length !== 1) remoteFailure('Remote file is missing or unreadable.');
      const entry = matches[0]!;
      if (entry.isReparsePoint) remoteFailure('SMB symbolic links and reparse points are unavailable.');
      if (index < parts.length - 1 && !entry.isDirectory) remoteFailure('Remote path is not a directory.');
      current = current ? current + '/' + entry.name : entry.name;
    }
    return { share, path: current, info: await this.info(share, current, signal) };
  }
  async list(path: string): Promise<RemoteEntry[]> {
    smbPath(path);
    if (!this.config.share && !this.config.root && !path) return (await this.shares()).map(name => ({ name, path: name, kind: 'directory', bytes: null }));
    const directory = await this.resolve(path);
    if (!directory.info.isDirectory) remoteFailure('Configured path is not a directory.');
    const entries: RemoteEntry[] = [];
    for (const entry of await this.rows(directory.share, directory.path)) {
      if (entry.name === '.' || entry.name === '..') continue;
      const relative = path ? path + '/' + entry.name : entry.name;
      try {
        smbPath(relative); if (entry.name.includes('/')) throw new ServiceError('INVALID_REQUEST', 'Invalid SMB relative path.');
        if (entry.isReparsePoint) remoteFailure('SMB symbolic links and reparse points are unavailable.');
        if (entry.sizeBytes < 0n || entry.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) remoteFailure('Unsupported remote entry.');
        entries.push({ name: entry.name, path: relative, kind: entry.isDirectory ? 'directory' : 'file', bytes: entry.isDirectory ? null : Number(entry.sizeBytes) });
      } catch (error) { entries.push({ name: entry.name, path: relative, kind: 'unavailable', bytes: null, error: error instanceof ServiceError ? error.message : 'Remote entry is unavailable.' }); }
    }
    return entries;
  }
  private async *chunks(share: string, path: string, bytes: number): AsyncGenerator<Buffer> {
    const session = await this.connection();
    for (let offset = 0; offset < bytes;) {
      const length = Math.min(1024 * 1024, bytes - offset);
      const chunk = await this.call(() => session.readRange(share, path, offset, length, { signal: this.options.signal }));
      if (chunk.length === 0 || chunk.length > length) changed();
      offset += chunk.length; yield chunk;
    }
  }
  async pin(path: string, destination: string, maxBytes: number, original?: RemoteFileVersion): Promise<RemotePinnedFile> {
    remotePath(path, false);
    if (original && original.kind !== 'smb') remoteFailure('Original version is unavailable. Select the file again.');
    const before = await this.resolve(path);
    if (before.info.isDirectory) remoteFailure('Select a readable file.');
    if (before.info.sizeBytes < 0n || before.info.sizeBytes > BigInt(Math.min(maxBytes, Number.MAX_SAFE_INTEGER))) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Remote file exceeds the 300 MiB import limit.');
    const bytes = Number(before.info.sizeBytes);
    let spooled = false, complete = false;
    try {
      const content = await spool(this.chunks(before.share, before.path, bytes), destination, maxBytes, this.options.signal, received => this.options.progress?.(received, bytes));
      spooled = true;
      const after = await this.resolve(path);
      if (after.share !== before.share || after.path !== before.path || !same(before.info, after.info) || content.bytes !== bytes) changed();
      const check = await spool(this.chunks(after.share, after.path, bytes), undefined, maxBytes, this.options.signal);
      const final = await this.resolve(path);
      if (final.share !== before.share || final.path !== before.path || !same(after.info, final.info) || check.sha256 !== content.sha256 || check.bytes !== content.bytes) changed();
      if (original && (original.sha256 !== content.sha256 || original.bytes !== content.bytes)) remoteFailure('Original version is unavailable. Select the file again.');
      complete = true; return { path: destination, version: { kind: 'smb', ...content } };
    } finally { if (spooled && !complete) await rm(destination, { force: true }); }
  }
  async preview(path: string): Promise<RemotePreviewReader> {
    remotePath(path, false); const before = await this.resolve(path);
    if (before.info.isDirectory || before.info.sizeBytes < 0n || before.info.sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) remoteFailure('Select a readable file.');
    const check = async (signal: AbortSignal) => {
      const current = await this.resolve(path, signal);
      if (current.share !== before.share || current.path !== before.path || !same(before.info, current.info)) remoteFailure('Remote file changed during preview. Open it again.');
    };
    return { bytes: Number(before.info.sizeBytes), read: async (start, end, requestSignal) => {
      const signal = AbortSignal.any([this.options.signal, requestSignal]); signal.throwIfAborted(); await check(signal);
      const session = await this.connection(), chunks: Buffer[] = []; let offset = start;
      while (offset <= end) {
        const length = Math.min(1024 * 1024, end - offset + 1);
        const chunk = await this.call(() => session.readRange(before.share, before.path, offset, length, { signal }), signal);
        if (!chunk.length || chunk.length > length) remoteFailure('Remote file changed during preview. Open it again.');
        chunks.push(chunk); offset += chunk.length;
      }
      signal.throwIfAborted(); await check(signal);
      return Buffer.concat(chunks, end - start + 1);
    } };
  }
  close(): void { if (this.closed) return; this.closed = true; if (this.session) void this.session.close().catch(() => {}); }
}
