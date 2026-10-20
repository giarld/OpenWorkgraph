import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentQueryContext } from '../contracts.js';
import { AgentError } from '../errors.js';
import { OpenCodePrivateInstance } from './instance.js';
import type { OpenCodeDeviceOptions } from './process.js';

/** Query acquisition and cleanup use the same ownership route as Runs. Register
 * cleanup before ANY resource acquisition, including the temporary directory.
 * Discovery's timeout/last-waiter abort cannot leave a late unowned service. */
export async function openCodeQueryInstance(device: OpenCodeDeviceOptions, context: AgentQueryContext, configuration?: Readonly<Record<string, unknown>>): Promise<OpenCodePrivateInstance> {
  let root: string | undefined, instance: OpenCodePrivateInstance | undefined;
  let cleanupRequested = false, removable = true;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const bridged = !!device.sdkPackageRoot && typeof context.options.sandboxMode === 'string';
  context.deferCleanup(async () => {
    cleanupRequested = true;
    await settled;
    if (instance) {
      if (bridged) {
        const signal = AbortSignal.timeout(10000);
        try {
          for (;;) {
            const value = await instance.transport.request('/api/workgraph/drain', { method: 'POST', signal }) as Record<string, unknown>;
            if (value.instanceId !== instance.identity.instanceId) throw new AgentError('outcome_unknown');
            if (value.drained === true) break;
            await new Promise(done => setTimeout(done, 25));
          }
        } catch { removable = false; throw new AgentError('outcome_unknown'); }
      }
      await instance.stop();
    }
    if (root && removable) await rm(root, { recursive: true, force: true });
    else if (!removable) throw new AgentError('outcome_unknown');
  });
  const check = () => { context.signal.throwIfAborted(); if (cleanupRequested) throw new AgentError('timeout'); };
  try {
    check();
    root = await mkdtemp(join(tmpdir(), 'owg-opencode-query-'));
    check();
    const id = 'query_' + randomUUID();
    instance = await OpenCodePrivateInstance.start({ directory: join(root, 'native'), cwd: context.projectPath ?? device.environment?.HOME ?? homedir(),
      runId: id, attemptId: id, device, signal: context.signal, ...(device.sdkPackageRoot && typeof context.options.sandboxMode === 'string' ? { bridge: { permissionMode: context.options.sandboxMode } } : {}), ...(configuration === undefined ? {} : { configuration }),
    });
    check();
    return instance;
  } catch (error) {
    if (error instanceof AgentError && error.reason === 'outcome_unknown') removable = false;
    throw error;
  } finally { settle(); }
}
