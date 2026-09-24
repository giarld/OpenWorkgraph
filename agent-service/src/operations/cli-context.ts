import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { managementPort } from './lifecycle.js';
import { atomicJson, privateDir, readSafe, safePath } from './files.js';
import { ServiceError } from '../errors.js';

/** Remember the one service's directory, never an IPC credential.
 * A separate home isolates test processes from the user's service and lock. */
function contextHome(): string { return process.env.OPENWORKGRAPH_CLI_HOME ?? join(homedir(), '.openworkgraph'); }
export async function rememberServiceDirectory(dataDir: string, home = contextHome()): Promise<void> {
  const directory = await realpath(await safePath(dataDir));
  await atomicJson(join(await privateDir(home), 'cli-context.json'), { version: 1, dataDir: directory });
}
/** A fixed loopback port enforces one CLI service per machine, even for different
 * data directories/users. No requests are served on this ownership-only socket. */
export async function acquireServiceSingleton() {
  const ports = process.env.OPENWORKGRAPH_CLI_HOME
    ? [managementPort(join(await privateDir(contextHome()), 'singleton'))]
    : [4316, 14316, 24316, 34316, 44316, 54316];
  for (const port of ports) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, done); });
    } catch (error) {
      // Windows can reserve a port without a listener. Every process tries the
      // same ordered list; an occupied usable port still means another owner.
      if ((error as NodeJS.ErrnoException).code === 'EACCES' && port !== ports.at(-1)) continue;
      const message = (error as NodeJS.ErrnoException).code === 'EACCES'
        ? 'No available local control port; check OS port reservations.'
        : 'A local service is already running or starting, or the control port is occupied. Run status, then stop before starting again.';
      throw new ServiceError('INVALID_REQUEST', message, { cause: error });
    }
    // Keep ownership for the process lifetime without preventing normal shutdown.
    server.unref();
    return { release: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
  }
  throw new ServiceError('INVALID_REQUEST', 'No available local control port; check OS port reservations.');
}
export async function selectedServiceDirectory(home = contextHome()): Promise<string> {
  let content: Buffer;
  try { content = await readSafe(join(home, 'cli-context.json'), 8192); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('SERVICE_NOT_RUNNING', 'No service has been started. Run start or serve first; only startup commands accept a data directory.');
    throw error;
  }
  const record = JSON.parse(content.toString()) as { version?: unknown; dataDir?: unknown };
  if (record.version !== 1 || typeof record.dataDir !== 'string' || !isAbsolute(record.dataDir)) throw new ServiceError('INVALID_REQUEST', 'The saved service directory is invalid. Start the service again with start or serve.');
  // Never silently fall back to another directory when the record is stale.
  return realpath(await safePath(record.dataDir));
}
