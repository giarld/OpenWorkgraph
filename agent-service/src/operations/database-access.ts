import { createServer, createConnection } from 'node:net';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { managementPort } from './lifecycle.js';
import { digest, safePath } from './files.js';

export function databaseAccessPort(root: string): number {
  const port = managementPort('database-access:' + root);
  return port === managementPort(root) ? (port === 59999 ? 20000 : port + 1) : port;
}

/** A busy port must identify this database lock, rather than another workspace
 * or an unrelated application. A released owner can disappear before probing. */
async function checkOwner(port: number, scope: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let input = '', settled = false;
    const done = (error?: Error) => {
      if (settled) return; settled = true; socket.destroy();
      if (error) reject(error); else resolve();
    };
    const occupied = () => new Error('Database access lock port is occupied by another listener');
    socket.setTimeout(1000, () => done(occupied()));
    socket.on('error', error => done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? undefined : error));
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.includes('\n') || input.length > 65) done(input === scope + '\n' ? undefined : occupied());
    });
    socket.on('close', () => done(occupied()));
  });
}

/** Coordinate independent CLI readers with database replacement. A kernel-held
 * listener releases on process exit, without stale lock files or PID heuristics.
 * The owning service keeps its separate lifetime lock throughout. */
export async function acquireDatabaseAccess(root: string, check: () => void = () => {}) {
  root = await realpath(await safePath(root));
  const port = databaseAccessPort(root), scope = digest('database-access:' + root);
  for (;;) {
    check();
    const server = createServer(socket => {
      socket.on('error', () => {});
      socket.end(scope + '\n', () => socket.destroy());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener('error', reject); resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await checkOwner(port, scope);
      await delay(25); continue;
    }
    let released: Promise<void> | undefined;
    return { release: () => released ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
  }
}
