import { existsSync } from 'node:fs';
import { initializeDirectories } from './directories.js';
import { openDatabase } from './persistence/database.js';
import { Repositories } from './persistence/repositories.js';
import { Auth } from './auth.js';
import { ServiceError } from './errors.js';
import type { ListenerInfo } from './network.js';

export function localControl(dataDir?: string) {
  const directories = initializeDirectories(dataDir);
  if (!existsSync(directories.database)) throw new ServiceError('SERVICE_NOT_RUNNING','This data directory has not been initialized. Start serve with the same --data-dir first.');
  const db = openDatabase(directories.database);
  const repo = new Repositories(db);
  const serviceId = repo.identity();
  const auth = new Auth(db,serviceId);
  async function pairingCode(origin: string, clientCode?: string) {
    const stored = repo.setting('listener');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || typeof stored['localEndpoint'] !== 'string') throw new ServiceError('SERVICE_NOT_RUNNING','The runtime is not listening. Run start or serve before requesting a pairing code; do not specify the directory again.');
    const listener = stored as unknown as ListenerInfo;
    try {
      const response = await fetch(listener.localEndpoint + '/v1/info',{headers:{'X-Workgraph-Service-Id':serviceId},signal:AbortSignal.timeout(2000),redirect:'error'});
      if (!response.ok || (await response.json() as {serviceId?:string}).serviceId !== serviceId) throw new Error();
    } catch { throw new ServiceError('SERVICE_NOT_RUNNING','The local runtime could not be verified. Run status and, if needed, start before retrying.'); }
    return { ...(clientCode ? auth.issueClientCode(clientCode) : auth.issueCode(origin)),endpoints:listener.endpoints,instructions:[
      'Enter the runtime address, serviceId, and pairing code on the web page. The pairing code is valid for 5 minutes and can be redeemed only once.',
      'The browser remembers the session. Pair again after 30 days of inactivity or after the session is revoked.',
      'All paired browsers have the same runtime management access and can view runtime details or revoke other sessions. This does not grant the Agent access to the whole machine.',
      (clientCode ? 'Enter the authorization code only on the original page that generated the client code. Refreshing or regenerating the client code requires new authorization. The client code binds the origin automatically. ' : 'This legacy origin-pairing entry point is retained for compatibility. New clients should use pair --client-code. ') + 'Pairing does not encrypt transport. Use HTTP only on a trusted local machine or LAN; never transmit credentials over the public internet or an untrusted network.'
    ] };
  }
  return { auth,pairingCode,close:() => db.close() };
}
