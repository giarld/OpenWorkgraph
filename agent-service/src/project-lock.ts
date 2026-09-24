import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { ServiceError } from './errors.js';

export function projectLockPort(canonicalPath: string): number {
  if (!isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath || canonicalPath.includes('\0')) throw new ServiceError('INVALID_REQUEST', 'Project lock requires the canonical absolute path');
  const user = userInfo();
  const hash = createHash('sha256').update(JSON.stringify(['openworkgraph-project-v1', user.uid, user.username, canonicalPath])).digest();
  return 20000 + hash.readUInt32BE(0) % 40000;
}
/** Kernel lifetime lock shared by service roots. Port collision is contention,
 * never evidence that a PID can be killed. Does not write into the source tree. */
export async function acquireProjectLock(canonicalPath: string): Promise<(() => void) | undefined> {
  const port = projectLockPort(canonicalPath);
  const server = createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  const acquired = await new Promise<boolean>((resolve, reject) => {
    const error = (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'EADDRINUSE') resolve(false);
      else reject(new ServiceError('PROJECT_UNAVAILABLE', 'Cannot acquire project lifetime lock', { cause }));
    };
    server.once('error', error);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', error); resolve(true); });
  });
  if (!acquired) return undefined;
  // An unresolved writer keeps the process/lock alive even if the HTTP UI closes.
  let released = false;
  return () => { if (released) return; released = true; server.close(); };
}
