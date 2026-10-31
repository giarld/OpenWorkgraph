import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, readFileSync, closeSync, fstatSync, writeFileSync, fsyncSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { DatabaseSync } from 'node:sqlite';
import type { DataSourceCredentials, HostTrustChallenge } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { atomic } from './persistence/database.js';
import type { Readable, Duplex } from 'node:stream';

// Keep third-party SSH declarations out of the published plugin-author API.
export interface RemoteSftpStats { size: number; mtime: number; mode: number; isDirectory(): boolean; isFile(): boolean }
export interface RemoteSftpEntry { filename: string; attrs: RemoteSftpStats }
export interface RemoteSftpClient {
  realpath(path: string, callback: (error: Error | undefined, result: string) => void): void;
  stat(path: string, callback: (error: Error | undefined, result: RemoteSftpStats) => void): void;
  readdir(path: string, callback: (error: Error | undefined, result: RemoteSftpEntry[]) => void): void;
  createReadStream(path: string, options: { autoClose: boolean }): Readable;
  end(): void;
}
export interface RemoteSshConnection {
  sftp(callback: (error: Error | undefined, result: RemoteSftpClient) => void): void;
  exec(command: string, callback: (error: Error | undefined, stream: Duplex & { stderr: Readable }) => void): void;
  end(): void;
  destroy(): void;
}

const invalid = (): never => { throw new ServiceError('INVALID_REQUEST', 'Invalid data source credentials.'); };
export function remoteId(id: string): string { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) invalid(); return id; }
function restricted(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) invalid();
  if (process.platform === 'win32') {
    const script = "$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; if($inputData.directory){$acl=New-Object System.Security.AccessControl.DirectorySecurity; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=New-Object System.Security.AccessControl.FileSecurity; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $inputData.path -AclObject $acl -ErrorAction Stop; $check=Get-Acl -LiteralPath $inputData.path; $rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl'){exit 1}";
    const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify({path,directory}), windowsHide: true, timeout:30000 });
    if (acl.status !== 0) throw new ServiceError('CONFLICT', 'Unable to restrict credential access.');
  } else if ((stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new ServiceError('CONFLICT', 'Credential storage permissions must be private.');
}
/** A distinct identity from model/skill credentials. No secret is persisted in SQLite. */
export class DataSourceCredentialStore {
  private readonly root: string;
  constructor(private readonly config: string, serviceId: string) { this.root = join(config, 'data-source-credentials', remoteId(serviceId)); }
  private initialize(): void {
    for (const path of [join(this.config, 'data-source-credentials'), this.root]) { mkdirSync(path, { recursive: true, mode: 0o700 }); restricted(path, true); }
  }
  private directory(id: string): string { return join(this.root, remoteId(id)); }
  read(id: string, generation?: string | null): DataSourceCredentials {
    if (generation === null) return {};
    const dir = this.directory(id), file = join(dir, 'credentials.json');
    try {
      restricted(this.root, true); restricted(dir, true); restricted(file, false);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (fstatSync(fd).size > 64 * 1024) invalid(); const stored = JSON.parse(readFileSync(fd, 'utf8')) as { generation: string; values: unknown }; return generation !== undefined && stored.generation !== generation ? {} : this.validate(stored.values); } finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; if(error instanceof ServiceError) throw error; throw new ServiceError('CONFLICT','Saved data source credentials are unavailable. Check the private credential store.'); }
  }
  validate(input: unknown): DataSourceCredentials {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
    const result: DataSourceCredentials = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (!['token', 'password', 'passphrase'].includes(key) || (value !== null && (typeof value !== 'string' || !value || value.length > 16 * 1024 || /[\x00\r\n]/.test(value)))) invalid();
      result[key as keyof DataSourceCredentials] = value as string | null;
    }
    return result;
  }
  write(id: string, patch: DataSourceCredentials, generation: string = randomUUID()): void {
    this.initialize();
    const old = this.read(id), next = { ...old, ...this.validate(patch) };
    const dir = this.directory(id); mkdirSync(dir, { mode: 0o700, recursive: true }); restricted(dir, true);
    const file = join(dir, randomUUID() + '.tmp');
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { restricted(file, false); writeFileSync(fd, JSON.stringify({generation, values: next})); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(file, join(dir, 'credentials.json')); } finally { rmSync(file, { force: true }); }
    if (process.platform !== 'win32') { const directory = openSync(dir, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); } }
  }
  remove(id: string): void { const dir = this.directory(id); try { restricted(dir, true); rmSync(dir, { recursive: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  status(id: string, generation?: string | null): { token: boolean; password: boolean; passphrase: boolean } { const values = this.read(id, generation); return { token: !!values.token, password: !!values.password, passphrase: !!values.passphrase }; }
}
export const fingerprint = (key: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
export class DataSourceHostTrust {
  constructor(readonly db: DatabaseSync) {}
  verify(sourceId: string, sourceRevision: number, endpoint: string, key: Buffer): boolean {
    return atomic(this.db, () => {
      if (this.db.prepare('SELECT revision FROM data_sources WHERE id=?').get(sourceId)?.revision !== sourceRevision) return false;
      const value = key.toString('base64');
      const previous = this.db.prepare('SELECT public_key FROM data_source_host_trust WHERE endpoint=?').get(endpoint)?.public_key;
      if (previous === value) return true;
      this.db.prepare('DELETE FROM data_source_host_challenges WHERE expires_at<? OR (source_id=? AND endpoint=?)').run(Date.now(), sourceId, endpoint);
      this.db.prepare('INSERT INTO data_source_host_challenges VALUES(?,?,?,?,?,?,?)').run(randomUUID(), sourceId, sourceRevision, endpoint, value, previous ?? null, Date.now() + 5 * 60_000);
      return false;
    });
  }
  challenges(sourceId: string): HostTrustChallenge[] {
    return this.db.prepare('SELECT * FROM data_source_host_challenges WHERE source_id=? AND expires_at>?').all(sourceId, Date.now()).map(row => ({ id: String(row.id), endpoint: String(row.endpoint), fingerprint: fingerprint(String(row.public_key)), previousFingerprint: row.previous_key ? fingerprint(String(row.previous_key)) : null, expiresAt: new Date(Number(row.expires_at)).toISOString() }));
  }
  confirm(sourceId: string, revision: number, challengeId: string): void {
    atomic(this.db, () => {
      const row = this.db.prepare('SELECT * FROM data_source_host_challenges WHERE id=? AND source_id=? AND source_revision=? AND expires_at>?').get(challengeId, sourceId, revision, Date.now());
      const current = row && this.db.prepare('SELECT public_key FROM data_source_host_trust WHERE endpoint=?').get(row.endpoint!)?.public_key;
      if (!row || (current ?? null) !== row.previous_key || this.db.prepare('SELECT revision FROM data_sources WHERE id=?').get(sourceId)?.revision !== revision) throw new ServiceError('REVISION_CONFLICT', 'Host confirmation expired. Test the connection again.');
      this.db.prepare('INSERT INTO data_source_host_trust VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET public_key=excluded.public_key').run(row.endpoint!, row.public_key!);
      this.db.prepare('DELETE FROM data_source_host_challenges WHERE endpoint=?').run(row.endpoint!);
    });
  }
}
export async function connectRemoteSsh(options: { host: string; port: number; username: string; auth: 'key' | 'password'; credentials: DataSourceCredentials; trust: DataSourceHostTrust; sourceId: string; revision: number; signal: AbortSignal; keyPath?: string }): Promise<RemoteSshConnection> {
  options.signal.throwIfAborted();
  const client = new Client();
  let rejectedHost = false;
  const config: ConnectConfig = { host: options.host, port: options.port, username: options.username, readyTimeout: 20_000, keepaliveInterval: 10_000, keepaliveCountMax: 2, hostVerifier: (key: Buffer) => { try { const valid = options.trust.verify(options.sourceId, options.revision, options.host.toLowerCase() + ':' + options.port, key); rejectedHost = !valid; return valid; } catch { rejectedHost = true; return false; } } };
  if (options.auth === 'key') {
    try { const fd = openSync(options.keyPath ?? join(homedir(), '.ssh', 'id_rsa'), constants.O_RDONLY | constants.O_NOFOLLOW); try { if (!fstatSync(fd).isFile() || fstatSync(fd).size > 1024 * 1024) throw Error(); config.privateKey = readFileSync(fd); } finally { closeSync(fd); } } catch { throw new ServiceError('CONFLICT', 'Cannot read ~/.ssh/id_rsa for this Workspace user.'); }
    if (options.credentials.passphrase) config.passphrase = options.credentials.passphrase;
  } else { if (!options.credentials.password) throw new ServiceError('CONFLICT', 'Save the SFTP password in data source settings.'); config.password = options.credentials.password; }
  return new Promise((resolve, reject) => {
    const abort = () => { client.destroy(); reject(new ServiceError('CONFLICT', 'Transfer cancelled.')); };
    options.signal.addEventListener('abort', abort, { once: true });
    client.once('close', () => options.signal.removeEventListener('abort', abort));
    client.on('error', () => reject(new ServiceError('CONFLICT', rejectedHost ? 'Confirm the SSH host fingerprint in data source settings, then retry manually.' : 'SSH connection or authentication failed. Check data source settings.')));
    client.once('ready', () => resolve(client as unknown as RemoteSshConnection));
    try { client.connect(config); } catch { client.destroy(); reject(new ServiceError('CONFLICT', 'SSH authentication failed. Check the key and passphrase.')); }
  });
}
