import { createServer, createConnection } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, digest, privateDir, readSafe, safePath, normalizeSystemPath } from './files.js';

export interface InstanceRecord { instanceId: string; serviceId: string; token: string; port: number; pid: number; startedAt: string }
export type ManagementCommand = 'status' | 'stop' | 'interrupt-and-stop' | 'pair-code' | 'pair-client' | 'resolve-client' | 'pair-short' | 'sessions' | 'revoke-session' | 'backup-create' | 'capacity' | 'plugin-register';
export type ManagementHandler = (command: ManagementCommand, argument?: string) => Promise<unknown>;
export function rootPath(dataDir?: string): string { return normalizeSystemPath(dataDir ?? join(homedir(), '.openworkgraph')); }
export function managementPort(root: string): number { return 20000 + Number.parseInt(digest(root).slice(0, 8), 16) % 40000; }
const equal = (a: unknown, b: string): boolean => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The kernel-held listener is the lifetime/maintenance lock. No PID killing,
 * stale-file deletion, expiry heuristics, or check-then-create races. Hash port
 * collisions fail closed. Only the loopback address is ever used. */
export async function acquireOperationsLock(dataDir?: string) {
  const root = await privateDir(rootPath(dataDir));
  const port = managementPort(root);
  const record: InstanceRecord = { instanceId: randomUUID(), serviceId: '', token: randomBytes(32).toString('hex'), port, pid: process.pid, startedAt: new Date().toISOString() };
  let handler: ManagementHandler | undefined;
  let released = false;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy());
    let input = ''; let handled = false;
    socket.on('data', chunk => {
      if (handled) return; input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 2 * 1024 * 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return; handled = true;
      void (async () => {
        const request = JSON.parse(input.slice(0, input.indexOf('\n'))) as Record<string, unknown>;
        if (!handler || !equal(request.token, record.token) || request.instanceId !== record.instanceId || request.serviceId !== record.serviceId) throw new Error('Unauthenticated instance');
        if (!['status', 'stop', 'interrupt-and-stop', 'pair-code', 'pair-client', 'resolve-client', 'pair-short', 'sessions', 'revoke-session', 'backup-create', 'capacity', 'plugin-register'].includes(String(request.command))) throw new Error('Unsupported local command');
        if (request.argument !== undefined && typeof request.argument !== 'string') throw new Error('Invalid argument');
        socket.setTimeout(0);
        const result = await handler(request.command as ManagementCommand, request.argument as string | undefined);
        socket.end(JSON.stringify({ ok: true, instanceId: record.instanceId, serviceId: record.serviceId, result }) + '\n');
      })().catch(() => socket.end(JSON.stringify({ ok: false, error: 'Management request refused' }) + '\n'));
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.removeListener('error', reject); done(); });
  }).catch(error => { throw new Error('Data directory is running or in maintenance, or its management port is occupied', { cause: error }); });
  return {
    root, record, get held() { return !released && server.listening; },
    async publish(serviceId: string, next: ManagementHandler, instanceId = record.instanceId) {
      record.serviceId = serviceId; record.instanceId = instanceId; handler = next;
      await atomicJson(join(root, 'operations-instance.json'), record);
    },
    async release() {
      if (released) return; released = true; handler = undefined;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      // Stale metadata is harmless. Retaining it avoids deleting a successor's record.
    },
  };
}
export type OperationsLock = Awaited<ReturnType<typeof acquireOperationsLock>>;
export async function readInstance(dataDir?: string): Promise<InstanceRecord> {
  const root = await realpath(await safePath(rootPath(dataDir)));
  const record = JSON.parse((await readSafe(join(root, 'operations-instance.json'), 8192)).toString()) as InstanceRecord;
  if (record.port !== managementPort(root) || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Invalid instance metadata');
  return record;
}
export async function requestInstance(record: InstanceRecord, command: ManagementCommand, argument?: string): Promise<unknown> {
  return new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: record.port });
    let input = ''; let complete = false;
    socket.setTimeout(command === 'backup-create' ? 300000 : 3000, () => socket.destroy(new Error('Local management timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ ...record, command, argument }) + '\n'));
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 65536) { socket.destroy(new Error('Oversized management response')); return; }
      if (!input.includes('\n') || complete) return; complete = true;
      try {
        const response = JSON.parse(input.slice(0, input.indexOf('\n'))) as { ok: boolean; serviceId: string; instanceId: string; result: unknown };
        if (!response.ok || response.serviceId !== record.serviceId || response.instanceId !== record.instanceId) throw new Error('Management identity/token mismatch');
        done(response.result);
      } catch (error) { reject(error); } finally { socket.destroy(); }
    });
    socket.once('close', () => { if (!complete) reject(new Error('Service not running or management unavailable')); });
  });
}
export async function manage(dataDir: string | undefined, command: ManagementCommand, argument?: string): Promise<unknown> { return requestInstance(await readInstance(dataDir), command, argument); }

export async function startBackground(cliPath: string, args: string[]): Promise<unknown> {
  // IPC carries the startup acknowledgment; stdio never inherits a terminal or
  // writes unbounded backend output. The daemon emits allowlisted lifecycle logs.
  const child = spawn(process.execPath, [cliPath, 'serve', ...args], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, OPENWORKGRAPH_BACKGROUND: '1' } });
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.disconnect(); child.unref(); reject(new Error('Startup acknowledgment timed out; inspect status before retrying')); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Background startup failed (' + code + ')')); });
    child.once('message', message => {
      clearTimeout(timeout); child.disconnect(); child.unref();
      const result = message as { ok: boolean; status?: unknown; error?: string };
      if (!result.ok) reject(new Error('Background startup refused: ' + (result.error ?? 'inspect status and logs'))); else done(result.status);
    });
  });
}
export async function waitUntilStopped(record: InstanceRecord, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await requestInstance(record, 'status'); }
    catch (error) {
      // An auth failure or closing DB is NOT proof of kernel-lock release.
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return;
    }
    await delay(50);
  }
  throw new Error('Service is still draining; interactions/cancel remain available');
}
