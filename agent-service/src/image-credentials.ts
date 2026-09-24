import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError } from './errors.js';
import type { DataDirectories } from './directories.js';

const identifier = (value: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ServiceError('INVALID_REQUEST', '凭据标识无效。');
  return value;
};
const scope = (serviceId: string, providerId: string, revision: number): string =>
  [identifier(serviceId), identifier(providerId), revision].join(':');

/** Fixed commands only. Secret input travels on stdin; platform diagnostics stay private. */
function invoke(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer=setTimeout(()=>child.kill(),30000);
    timer.unref();
    const output: Buffer[] = [];
    let length = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024) child.kill(); else output.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => { /* A missing/closed platform store must not crash the Runtime. */ });
    child.on('error', () => {clearTimeout(timer);reject(new ServiceError('MODEL_UNAVAILABLE', '本机凭据存储不可用。'));});
    child.on('close', code => {clearTimeout(timer);code === 0 && length <= 64 * 1024 ? resolve(Buffer.concat(output).toString('utf8').trimEnd()) : reject(new ServiceError('MODEL_UNAVAILABLE', '本机凭据存储操作失败。'));});
    child.stdin.end(input === undefined ? '' : input + String.fromCharCode(10));
  });
}

const encrypt = '$v=[Console]::In.ReadToEnd().TrimEnd([char]10,[char]13); ConvertFrom-SecureString (ConvertTo-SecureString -String $v -AsPlainText -Force)';
const decrypt = '$v=[Console]::In.ReadToEnd().TrimEnd([char]10,[char]13); $s=ConvertTo-SecureString $v; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';

export class ImageCredentials {
  private readonly credentialDir: string;
  constructor(private readonly dirs: DataDirectories, private readonly serviceId: string) {
    this.credentialDir = join(dirs.config, 'image-credentials');
    if (process.platform === 'win32' || process.platform === 'darwin') {
      mkdirSync(this.credentialDir, { recursive: true, mode: 0o700 });
      const stat=lstatSync(this.credentialDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServiceError('INVALID_REQUEST','凭据目录不能是符号链接。');
      if (process.platform === 'darwin') chmodSync(this.credentialDir, 0o700);
    }
  }
  private file(id: string, revision: number): string { return join(this.credentialDir, identifier(this.serviceId) + '.' + Buffer.from(identifier(id)).toString('hex') + '.' + revision + (process.platform === 'darwin' ? '.key' : '.dpapi')); }
  async store(id: string, revision: number, value: string): Promise<void> {
    const key = scope(this.serviceId, id, revision);
    if (typeof value !== 'string' || !value.trim() || value.length > 16 * 1024 || value.includes(String.fromCharCode(10)) || value.includes(String.fromCharCode(13))) throw new ServiceError('INVALID_REQUEST', '凭据格式无效。');
    if (process.platform === 'darwin') {
      const path=this.file(id,revision);
      const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try { writeFileSync(fd,value,'utf8'); }
      catch(error) { closeSync(fd); unlinkSync(path); throw error; }
      closeSync(fd);
    } else if (process.platform === 'linux') {
      await invoke('secret-tool', ['store', '--label=OpenWorkgraph image provider', 'service', 'OpenWorkgraph-image-provider', 'account', key], value);
    } else if (process.platform === 'win32') {
      const ciphertext = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', encrypt], value);
      if (!ciphertext) throw new ServiceError('MODEL_UNAVAILABLE', '本机凭据保护失败。');
      writeFileSync(this.file(id, revision), ciphertext, { flag: 'wx', mode: 0o600 });
    } else throw new ServiceError('MODEL_UNAVAILABLE', '此平台没有受保护的凭据存储。');
    if (await this.read(id, revision) !== value) {
      await this.revoke(id, revision).catch(() => {});
      throw new ServiceError('MODEL_UNAVAILABLE', 'API Key 写入后无法从本机凭据存储读取。');
    }
  }
  async read(id: string, revision: number): Promise<string | null> {
    const key = scope(this.serviceId, id, revision);
    try {
      let value: string;
      if (process.platform === 'darwin') {
        const fd=openSync(this.file(id,revision),constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          const stat=fstatSync(fd);
          if(!stat.isFile() || stat.mode&0o077 || stat.size>16*1024) return null;
          value=readFileSync(fd,'utf8');
        } finally { closeSync(fd); }
      }
      else if (process.platform === 'linux') value = await invoke('secret-tool', ['lookup', 'service', 'OpenWorkgraph-image-provider', 'account', key]);
      else if (process.platform === 'win32') {
        const path = this.file(id, revision), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw Error('Invalid credential file');
        value = await invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', decrypt], readFileSync(path, 'utf8'));
      } else return null;
      return value || null;
    } catch { return null; }
  }
  async revoke(id: string, revision: number): Promise<void> {
    const key = scope(this.serviceId, id, revision);
    if (process.platform === 'darwin') unlinkSync(this.file(id,revision));
    else if (process.platform === 'linux') await invoke('secret-tool', ['clear', 'service', 'OpenWorkgraph-image-provider', 'account', key]);
    else if (process.platform === 'win32') unlinkSync(this.file(id, revision));
    else throw new ServiceError('MODEL_UNAVAILABLE', '本机凭据存储不可用。');
  }
}
