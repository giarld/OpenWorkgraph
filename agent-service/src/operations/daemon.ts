import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { createService } from '../service.js';
import { listenerInfo } from '../network.js';
import { localControl } from '../local-control.js';
import { acquireOperationsLock } from './lifecycle.js';
import { OperationsLog } from './logs.js';
import { waitForBackups, clearStaleResourceLeases } from './backups.js';
import { localCapacity } from './capacity.js';
import { registerLocalPlugin } from './plugins.js';
import { fileURLToPath } from 'node:url';
import { isGlobalNpmInstallation, startWebUpdate } from './update.js';
export function activeRunCount(db: DatabaseSync): number {
  return Number(db.prepare("SELECT count(*) AS n FROM runs WHERE status NOT IN ('accepted','queued','paused_restore','succeeded','failed','cancelled','interrupted')").get()!.n);
}
/** Public host wrapper: the lock is acquired BEFORE opening SQLite or listeners. */
export async function serveManaged(dataDir: string | undefined, host: string, port: number, onStopped?: () => Promise<void>) {
  const lock = await acquireOperationsLock(dataDir), log = new OperationsLog(lock.root);
  let service: ReturnType<typeof createService>;
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
  const npmInstallation = isGlobalNpmInstallation(cliPath);
  try { service = createService(lock.root, {
    npmInstallation: () => npmInstallation,
    updateRuntime: async onExit => {
      if (state !== 'running') throw new Error('Runtime is stopping.');
      await startWebUpdate(cliPath, undefined, onExit);
    },
  }); } catch (error) { try { await log.append('startup_failed'); } finally { await lock.release(); } throw error; }
  let state: 'running' | 'draining' | 'interrupting' | 'failed' = 'running';
  let stopping = false;
  const drains = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  let recoveryAttempted = false;
  const onSignal = () => { void stop(false).catch(() => log.append('shutdown_failed')); };
  const removeSignals = () => { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); };
  const status = () => ({ state, activeRuns: activeRunCount(service.db), listenHost: (service.server.address() as AddressInfo).address, ...listenerInfo(service.server.address() as AddressInfo, service.info.serviceId, service.instanceId) });
  async function stop(interrupt: boolean): Promise<void> {
    // Escalation remains available while an earlier drain waits indefinitely.
    if (stopping && (!interrupt || state === 'interrupting')) return;
    state = interrupt ? 'interrupting' : 'draining';
    stopping = true;
    service.runtime.stopRuns();
    await log.append(interrupt ? 'interrupting' : 'draining');
    const drain = (async () => {
      // Flush the command acknowledgment before any transport is closed.
      await new Promise(resolve => setTimeout(resolve, 30));
      await Promise.all([waitForBackups(service.db), service.runtime.drain({ interrupt: true })]);
    })();
    drains.add(drain);
    void drain.then(async () => {
      drains.delete(drain);
      if (drains.size || closing || state === 'failed') return;
      closing = (async () => {
        await service.close();
        removeSignals();
        try { await log.append('stopped'); } finally { await lock.release(); await onStopped?.(); }
      })();
      try {
        await closing;
      } catch {
        state = 'failed'; await log.append('shutdown_failed');
      }
    }, async () => {
      drains.delete(drain); state = 'failed'; await log.append('shutdown_failed');
      // Keep ownership while backend termination is uncertain.
    }).catch(() => { /* Diagnostics failures must not become unhandled rejections. */ });
  }
  try {
    clearStaleResourceLeases(service.db, lock);
    await service.api.backups.recoverCreating(lock);
    await new Promise<void>((done, reject) => { service.server.once('error', reject); service.server.listen(port, host, done); });
    // Own the kernel lock before transferring scheduler epochs. Runtime.start
    // resets acceptingRuns after a normal shutdown and starts its dispatch timer.
    recoveryAttempted = true;
    await service.runtime.recover();
    await lock.publish(service.info.serviceId, async (command, argument) => {
      if (command === 'status') return status();
      if (command === 'capacity') return localCapacity(service.db, argument);
      if (command === 'plugin-register') return registerLocalPlugin(service.db, service.info.serviceId, argument ?? '');
      if (command === 'sessions') return service.auth.list();
      if (command === 'resolve-client') return service.auth.resolveClientPairing(argument ?? '');
      if (command === 'pair-short') {
        const request = JSON.parse(argument ?? '{}') as { code: string; clientCode: string };
        return service.auth.approveClientPairing(request.code, request.clientCode);
      }
      if (command === 'revoke-session') { service.auth.revokeLocal(argument ?? ''); return { revoked: argument, acceptedTasksUnaffected: true }; }
      if (command === 'pair-code' || command === 'pair-client') {
        const control = localControl(lock.root);
        try { return await control.pairingCode(command === 'pair-code' ? argument ?? '' : '', command === 'pair-client' ? argument ?? '' : undefined); } finally { control.close(); }
      }
      if (command === 'backup-create') {
        if (state !== 'running') throw new Error('Service is draining; new backups are unavailable');
        const result = await service.api.backups.create(argument);
        await log.append('backup_ready'); return result;
      }
      await stop(command === 'interrupt-and-stop'); return { state, serviceId: service.info.serviceId, instanceId: service.instanceId };
    }, service.instanceId);
    await log.append('started');
  } catch (error) {
    removeSignals();
    // Before epoch transfer there is no backend owned by this startup. Draining
    // old active rows here would wait forever and could mutate the previous Run.
    // Once recovery was attempted, retain the normal conservative drain path.
    if (!recoveryAttempted) await service.abortStartup();
    else await service.close();
    try { await log.append('startup_failed'); } finally { await lock.release(); }
    throw error;
  }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  return { service, lock, status, stop };
}
