import { Client } from 'basic-ftp';
import { PassThrough, Writable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { posix } from 'node:path';
import type { DataSource, RemoteEntry, RemoteFileVersion } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { remoteFailure, remotePath, spool } from './remote-assets-connectors.js';
import type { ConnectionOptions, RemoteConnector, RemotePinnedFile, RemotePreviewReader } from './remote-assets-connectors.js';

interface FtpEntry { name: string; size: number; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; rawModifiedAt: string; uniqueID?: string }
/** Keep the dependency's types out of the public service SDK. */
export interface RemoteFtpClient {
  access(options: { host: string; port: number; user: string; password: string; secure: boolean | 'implicit'; secureOptions: { rejectUnauthorized: boolean } }): Promise<unknown>;
  cd(path: string): Promise<unknown>;
  pwd(): Promise<string>;
  list(path: string): Promise<FtpEntry[]>;
  downloadTo(destination: Writable, path: string, startAt?: number): Promise<unknown>;
  close(): void;
}
export function ftpPath(input: unknown): string {
  const path = remotePath(input);
  // FTP LIST implementations may expand wildcards; commands must stay literal.
  if (/[\x7f*?\[\]]/.test(path)) throw new ServiceError('INVALID_REQUEST', 'Invalid FTP relative path.');
  return path;
}
const failure = 'FTP connection or read failed. Check the server and credentials.';
function ftpError(error: unknown): never {
  if (error instanceof ServiceError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const message = code === 530 || code === 532 ? 'FTP authentication failed. Check data source credentials.'
    : code === 550 ? 'Remote file is missing or unreadable.'
    : typeof code === 'string' && /CERT|TLS|SSL|SELF_SIGNED/.test(code) ? 'FTPS certificate or TLS negotiation failed. Check the server certificate and security mode.' : failure;
  // Raw responses can echo commands, paths or credentials.
  throw new ServiceError('CONFLICT', message);
}
const same = (a: FtpEntry, b: FtpEntry) => a.size === b.size && a.rawModifiedAt === b.rawModifiedAt && a.uniqueID === b.uniqueID && a.isFile === b.isFile && a.isDirectory === b.isDirectory;
const changed = () => remoteFailure('Remote file changed during transfer. Select the file again.');

export class FtpConnector implements RemoteConnector {
  private client?: RemoteFtpClient;
  private initialized = false;
  private closed = false;
  private root = '/';
  private readonly config: Extract<DataSource['config'], { kind: 'ftp' }>;
  constructor(private readonly source: DataSource, private readonly options: ConnectionOptions) {
    if (source.config.kind !== 'ftp') throw Error();
    this.config = source.config;
  }
  private async call<T>(work: () => Promise<T>): Promise<T> {
    const signal = this.options.signal; signal.throwIfAborted();
    if (this.closed) remoteFailure(failure);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => { this.close(); reject(signal.reason); }; signal.addEventListener('abort', abort, { once: true }); });
    try { const result = await Promise.race([work(), cancelled]); signal.throwIfAborted(); return result; }
    catch (error) { signal.throwIfAborted(); return ftpError(error); }
    finally { signal.removeEventListener('abort', abort); }
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const password = this.options.credentials.password;
    if (typeof password !== 'string') remoteFailure('Enter the FTP password in data source settings.');
    await this.call(async () => {
      const client = this.options.ftpClient?.() ?? new Client(30_000, { allowSeparateTransferHost: false, maxListingBytes: 8 * 1024 * 1024 });
      this.client = client;
      await client.access({ host: this.config.host, port: this.config.port, user: this.config.username, password: password!, secure: this.config.security === 'implicit' ? 'implicit' : this.config.security === 'explicit', secureOptions: { rejectUnauthorized: true } });
      // access() selects MLSD automatically. Switch afterwards: LIST exposes
      // Unix symlinks while MLSD servers can silently report their target type.
      if (client instanceof Client) client.availableListCommands = ['LIST -a', 'LIST'];
      if (this.closed || this.options.signal.aborted) { client.close(); this.options.signal.throwIfAborted(); remoteFailure(failure); }
      await client.cd('/');
      let current = await this.directoryPath();
      for (const part of this.config.root.split('/').filter(Boolean)) {
        const entry = await this.entry(current, part);
        if (!entry.isDirectory) remoteFailure('Configured root is not a directory.');
        await client.cd(posix.join(current, part)); current = await this.directoryPath();
      }
      this.root = current; this.initialized = true;
    });
  }
  private async directoryPath(): Promise<string> {
    const path = await this.client!.pwd();
    if (!path.startsWith('/')) remoteFailure('Configured root is not a directory.');
    ftpPath(path.slice(1)); return path;
  }
  private async rows(path: string): Promise<FtpEntry[]> { return this.call(() => this.client!.list(path)); }
  private async entry(directory: string, name: string): Promise<FtpEntry> {
    const matches = (await this.rows(directory)).filter(entry => entry.name === name);
    if (matches.length !== 1) remoteFailure('Remote file is missing or unreadable.');
    const entry = matches[0]!;
    if (entry.isSymbolicLink) remoteFailure('FTP symbolic links are unavailable.');
    if ((!entry.isFile && !entry.isDirectory) || !Number.isSafeInteger(entry.size) || entry.size < 0) remoteFailure('Unsupported remote entry.');
    return entry;
  }
  private async resolve(path: string): Promise<{ path: string; info: FtpEntry | undefined }> {
    ftpPath(path); await this.initialize();
    let configured = '/';
    for (const part of this.root.split('/').filter(Boolean)) {
      if (!(await this.entry(configured, part)).isDirectory) remoteFailure('Configured root is not a directory.');
      configured = posix.join(configured, part);
    }
    let current = this.root, info: FtpEntry | undefined;
    const parts = path ? path.split('/') : [];
    for (const [index, part] of parts.entries()) {
      info = await this.entry(current, part); current = posix.join(current, part);
      if (index < parts.length - 1 && !info.isDirectory) remoteFailure('Remote path is not a directory.');
    }
    return { path: current, info };
  }
  async list(path: string): Promise<RemoteEntry[]> {
    const directory = await this.resolve(path);
    if (directory.info && !directory.info.isDirectory) remoteFailure('Remote path is not a directory.');
    return (await this.rows(directory.path)).filter(entry => !['.', '..'].includes(entry.name)).map(entry => {
      const relative = path ? path + '/' + entry.name : entry.name;
      try {
        ftpPath(relative);
        if (!entry.name || entry.name.includes('/')) remoteFailure('Unsupported remote entry.');
        if (entry.isSymbolicLink) remoteFailure('FTP symbolic links are unavailable.');
        if ((!entry.isFile && !entry.isDirectory) || !Number.isSafeInteger(entry.size) || entry.size < 0) remoteFailure('Unsupported remote entry.');
        return { name: entry.name, path: relative, kind: entry.isDirectory ? 'directory' : 'file', bytes: entry.isDirectory ? null : entry.size };
      } catch (error) { return { name: entry.name, path: relative, kind: 'unavailable', bytes: null, error: error instanceof ServiceError ? error.message : 'Remote entry is unavailable.' }; }
    });
  }
  private async download(path: string, destination: string | undefined, max: number, bytes: number): Promise<{ sha256: string; bytes: number }> {
    const stream = new PassThrough(); stream.on('error', () => {});
    const download = this.call(() => this.client!.downloadTo(stream, path)).catch(error => { stream.destroy(error); throw error; });
    const consume = spool(stream, destination, max, this.options.signal, destination ? received => this.options.progress?.(received, bytes) : undefined);
    try {
      const [content] = await Promise.all([consume, download]);
      return content;
    } catch (error) {
      this.close(); stream.destroy();
      await consume.then(async () => { if (destination) await rm(destination, { force: true }); }, () => {});
      throw error;
    }
    finally { stream.destroy(); }
  }
  async pin(path: string, destination: string, maxBytes: number, original?: RemoteFileVersion): Promise<RemotePinnedFile> {
    remotePath(path, false);
    if (original && original.kind !== 'ftp') remoteFailure('Original version is unavailable. Select the file again.');
    const before = await this.resolve(path);
    if (!before.info?.isFile) remoteFailure('Select a readable file.');
    const info = before.info!;
    if (info.size > maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Remote file exceeds the 300 MiB import limit.');
    let spooled = false, complete = false;
    try {
      const content = await this.download(before.path, destination, maxBytes, info.size); spooled = true;
      const after = await this.resolve(path);
      if (!after.info || after.path !== before.path || !same(info, after.info) || content.bytes !== info.size) changed();
      const check = await this.download(before.path, undefined, maxBytes, info.size), final = await this.resolve(path);
      if (!final.info || final.path !== before.path || !same(info, final.info) || check.bytes !== content.bytes || check.sha256 !== content.sha256) changed();
      if (original && (original.bytes !== content.bytes || original.sha256 !== content.sha256)) remoteFailure('Original version is unavailable. Select the file again.');
      complete = true; return { path: destination, version: { kind: 'ftp', ...content } };
    } finally { if (spooled && !complete) await rm(destination, { force: true }); }
  }
  async preview(path: string): Promise<RemotePreviewReader> {
    remotePath(path, false); const before = await this.resolve(path);
    if (!before.info?.isFile) remoteFailure('Select a readable file.');
    const check = async (connector: FtpConnector) => {
      const current = await connector.resolve(path);
      if (!current.info || current.path !== before.path || !same(before.info!, current.info)) remoteFailure('Remote file changed during preview. Open it again.');
    };
    return { bytes: before.info!.size, read: async (start, end, requestSignal) => {
      const signal = AbortSignal.any([this.options.signal, requestSignal]); signal.throwIfAborted();
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= before.info!.size || end - start + 1 > 1024 * 1024) throw new ServiceError('INVALID_REQUEST', 'Invalid remote preview byte range.');
      // RETR has no end offset. Use REST and close a separate connection as soon
      // as the range is filled, so previews never download the remaining file.
      const reader = new FtpConnector(this.source, { ...this.options, signal });
      const verifier = new FtpConnector(this.source, { ...this.options, signal });
      const chunks: Buffer[] = []; let received = 0, stopped = false;
      const length = end - start + 1;
      const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
        const part = chunk.subarray(0, length - received); chunks.push(part); received += part.length;
        if (received === length) { stopped = true; reader.close(); }
        callback();
      } });
      output.on('error', () => {});
      try {
        await check(reader);
        try { await reader.call(() => reader.client!.downloadTo(output, before.path, start)); }
        catch (error) { signal.throwIfAborted(); if (!stopped) throw error; }
        signal.throwIfAborted();
        if (received !== length) remoteFailure('Remote file changed during preview. Open it again.');
        // RETR closes reader at the end offset. Verify on another request-bound
        // connection so a cancelled LIST cannot block this preview's next read.
        await check(verifier); signal.throwIfAborted(); return Buffer.concat(chunks, length);
      } finally { reader.close(); verifier.close(); output.destroy(); }
    } };
  }
  close(): void { if (this.closed) return; this.closed = true; this.client?.close(); }
}
