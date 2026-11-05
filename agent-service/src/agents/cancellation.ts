import { AgentError } from './errors.js';

/** The first cooperative request plus three retries. A successful HTTP ACK is
 * insufficient: soft() must confirm the original actions actually drained. */
export async function cancelAgentRun(soft: (signal: AbortSignal) => Promise<boolean>, force: () => Promise<void>, attemptMs = 2000): Promise<'soft' | 'forced'> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([
        soft(controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AgentError('timeout')); }, attemptMs); }),
      ]);
      if (stopped) return 'soft';
    } catch { /* A lost reply, timeout or remaining work consumes this attempt. */ }
    finally { clearTimeout(timer); controller.abort(); }
  }
  await force();
  return 'forced';
}
