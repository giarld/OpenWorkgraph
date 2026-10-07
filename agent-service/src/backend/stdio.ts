import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { BackendError } from './types.js';
export type RpcId = string | number;
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
export type RpcMessage = { id?: RpcId; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
export interface StdioOptions { executable?: string; args?: string[]; cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; initializeTimeoutMs?: number; maxFrameBytes?: number }
/** Bounded diagnostic categories only; never include stderr, frames, commands or paths. */
export interface TransportFailure { kind: "process_exit" | "spawn_error" | "stdin_error" | "frame_too_large" | "invalid_frame" | "rpc_timeout" | "host_close"; spawnCode?: 'ENOENT' | 'EACCES' | 'EPERM' | 'ENOEXEC'; exitCode?: number | null; exitSignal?: string | null; observedFrameBytes?: number }
/** npm's Windows .cmd shim cannot be spawned with shell:false. Use its JS entry. */
export function codexCommand(options: StdioOptions, platform = process.platform): { executable: string; args: string[] } {
  const executable = options.executable ?? 'codex';
  const args = options.args ?? ['app-server', '--stdio'];
  if (platform !== 'win32') return { executable, args };
  const env = options.env ?? process.env;
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const directories = executable === 'codex' ? path.split(';').filter(Boolean).map(p => p.replace(/^"|"$/g, '')) : /(?:^|[\\/])codex[.](?:cmd|ps1)$/i.test(executable) && isAbsolute(executable) ? [dirname(executable)] : [];
  // A running Runtime retains its original PATH when npm installs Codex later.
  // npm's default per-user bin directory remains discoverable through APPDATA.
  if (executable === 'codex' && env.APPDATA) directories.push(join(env.APPDATA, 'npm'));
  for (const directory of directories) {
    const native = join(directory, 'codex.exe');
    if (existsSync(native)) return { executable: native, args };
    const entry = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entry)) return { executable: process.execPath, args: [entry, ...args] };
  }
  return { executable, args };
}
/** Private wire transport: never forward raw backend messages/errors/stderr to HTTP. */
export class StdioRpc {
  private child: ChildProcessWithoutNullStreams; private nextId = 0; private buffer = ''; private bufferBytes = 0; private decoder = new StringDecoder('utf8'); private stopped = false; private exited = false;
  private failureKind: TransportFailure["kind"] | null = null; private exitCode: number | null = null; private exitSignal: string | null = null;
  private observedFrameBytes: number | undefined;
  private spawnCode: TransportFailure['spawnCode'];
  private pending = new Map<RpcId, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; method: string }>();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (id: RpcId, method: string, params: any) => void = id => this.reject(id);
  onDisconnect: () => void = () => {};
  get isClosed(): boolean { return this.stopped; }
  /** Exit is stronger evidence than a broken stdio pipe: this child can no longer run a turn. */
  get isExited(): boolean { return this.exited; }
  get failure(): TransportFailure | null { return this.failureKind ? { kind: this.failureKind, ...(this.spawnCode ? { spawnCode: this.spawnCode } : {}), ...(this.exited ? { exitCode: this.exitCode, exitSignal: this.exitSignal } : {}), ...(this.observedFrameBytes !== undefined ? { observedFrameBytes: this.observedFrameBytes } : {}) } : null; }
  constructor(private readonly options: StdioOptions) {
    const command = codexCommand(options);
    this.child = spawn(command.executable, command.args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    this.child.stderr.resume(); // Drain, but never persist credentials/backend diagnostics.
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(error.code ?? '')) this.spawnCode = error.code as TransportFailure['spawnCode'];
      this.fail('spawn_error');
    });
    this.child.on('exit', (code, signal) => { this.exited = true; this.exitCode = code; this.exitSignal = signal; this.fail('process_exit'); });
    this.child.stdin.on('error', () => this.fail('stdin_error'));
    this.child.stdout.on('data', (chunk: Buffer) => {
      const decoded = this.decoder.write(chunk); this.buffer += decoded; this.bufferBytes += Buffer.byteLength(decoded);
      const max = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        this.bufferBytes -= Buffer.byteLength(line) + 1;
        if (Buffer.byteLength(line) > max) { this.observedFrameBytes = Buffer.byteLength(line); this.fail('frame_too_large'); return; }
        if (!line.trim()) continue;
        try { const message = JSON.parse(line); this.receive(message); } catch { this.fail('invalid_frame'); return; }
      }
      if (this.bufferBytes > max) { this.observedFrameBytes = this.bufferBytes; this.fail('frame_too_large'); }
    });
  }
  private receive(m: RpcMessage): void {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Invalid frame');
    if (m.id !== undefined && typeof m.id !== 'string' && typeof m.id !== 'number') throw new Error('Invalid id');
    if (typeof m.method === 'string') { if (m.id !== undefined) this.onRequest(m.id, m.method, m.params); else this.onNotification(m.method, m.params); return; }
    if (m.id === undefined) throw new Error('Missing id');
    const pending = this.pending.get(m.id); if (!pending) return;
    this.pending.delete(m.id); clearTimeout(pending.timer);
    if (m.error) pending.reject(new BackendError('PROTOCOL', 'Backend rejected request', { method: pending.method, ...(Number.isSafeInteger(m.error.code) ? { rpcCode: m.error.code } : {}) }));
    else if ('result' in m) pending.resolve(m.result); else pending.reject(new BackendError('PROTOCOL', 'Missing backend result', { method: pending.method }));
  }
  private write(message: RpcMessage): void {
    if (this.stopped) throw new BackendError('UNAVAILABLE', 'Backend connection closed');
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES) || this.child.stdin.writableLength > 2 * 1024 * 1024) throw new BackendError('PROTOCOL', 'Backend message limit exceeded');
    this.child.stdin.write(line);
  }
  request(method: string, params: unknown, requestTimeoutMs?: number): Promise<any> {
    if (this.pending.size >= 128) return Promise.reject(new BackendError('PROTOCOL', 'Too many backend requests'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timeoutMs = requestTimeoutMs ?? (method === 'initialize' ? this.options.initializeTimeoutMs ?? this.options.timeoutMs ?? 60000 : this.options.timeoutMs ?? 15000);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BackendError('TIMEOUT', 'Backend request timed out; outcome unknown', { method, timeoutMs })); this.fail('rpc_timeout'); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string): void { this.write({ method }); }
  reply(id: RpcId, result: unknown): void { this.write({ id, result }); }
  reject(id: RpcId): void { this.write({ id, error: { code: -32601, message: 'Unsupported backend request' } }); }
  private fail(kind: TransportFailure["kind"]): void {
    if (!this.failureKind) this.failureKind = kind;
    if (this.stopped) return; this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BackendError('UNAVAILABLE', 'Backend disconnected; outcome unknown', { method: p.method })); }
    this.pending.clear(); this.child.kill('SIGTERM');
    const child = this.child; const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000); killTimer.unref();
    this.onDisconnect();
  }
  close(): void { this.fail("host_close"); }
}
