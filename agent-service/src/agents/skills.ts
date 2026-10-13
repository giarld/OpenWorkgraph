import { isSkillIdentity, isSkillName } from '@openworkgraph/protocol';
import type { FrozenAgentSelection, AgentPlatform } from '@openworkgraph/protocol';
import type { AgentPlugin, AgentQueryContext } from './contracts.js';
import { AgentError, agentError } from './errors.js';
import { exactKeys, isPlainRecord, normalizeConfiguration, publicText, validPlatform } from './configuration.js';

export interface NativeSkillCatalog { backendId: string; configuredSkills: boolean; skills: { skillId: string; name: string; description: string }[] }
export interface NativeSkillCatalogOptions { timeoutMs?: number; cleanupTimeoutMs?: number; signal?: AbortSignal; platform?: AgentPlatform; projectPath?: string }
function boundedMs(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw new AgentError('invalid_configuration');
  return selected;
}
function abortError(): DOMException { return new DOMException('Aborted', 'AbortError'); }
/** Public stable identities only, never filesystem paths or raw native data.
 * Cleanup is registered before acquisition; aborted queries must not acquire late
 * resources. Every registered hook gets one bounded execution on all outcomes. */
export async function nativeSkillCatalog(plugin: AgentPlugin, frozen: Pick<FrozenAgentSelection, 'backendId' | 'options'>, timeout: number | NativeSkillCatalogOptions = 10_000): Promise<NativeSkillCatalog> {
  const request = typeof timeout === 'number' ? { timeoutMs: timeout } : timeout;
  if (!isPlainRecord(request as unknown) || !exactKeys(request as unknown as Record<string, unknown>, ['timeoutMs', 'cleanupTimeoutMs', 'signal', 'platform', 'projectPath']) || request.signal !== undefined && !(request.signal instanceof AbortSignal) || request.projectPath !== undefined && (typeof request.projectPath !== 'string' || !request.projectPath)) throw new AgentError('invalid_configuration');
  // Keep the outer cleanup budget above the native stdio drain's 3s deadline.
  const timeoutMs = boundedMs(request.timeoutMs, 10_000, 120_000), cleanupMs = boundedMs(request.cleanupTimeoutMs, 5_000, 30_000);
  const platform = request.platform ?? process.platform as AgentPlatform;
  const backendId = frozen.backendId;
  if (!validPlatform(platform) || !isSkillIdentity({ source: 'agent', backendId, skillId: 'identity-check' }) || backendId !== plugin.descriptor.id) throw new AgentError('protocol_error');
  const normalized = normalizeConfiguration(plugin.descriptor.configuration, frozen.options, plugin.descriptor.configuration.version, platform);
  if (Object.keys(normalized).length !== Object.keys(frozen.options).length || Object.entries(normalized).some(([key, value]) => frozen.options[key] !== value)) throw new AgentError('invalid_configuration');
  const options = Object.freeze(structuredClone(normalized));
  const result: NativeSkillCatalog = { backendId, configuredSkills: plugin.descriptor.capabilities.configuredSkills, skills: [] };
  const extension = plugin.extensions?.nativeSkills;
  if (plugin.descriptor.capabilities.nativeSkills !== !!extension) throw new AgentError('protocol_error');
  if (request.signal?.aborted) throw abortError();
  if (!extension) return result;
  const controller = new AbortController(), hooks: (() => void | Promise<void>)[] = [];
  let cleaning = false, hookCount = 0;
  const cleanup = async (hook: () => void | Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(hook), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgentError('timeout')), cleanupMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const context: AgentQueryContext = Object.freeze({ platform, options, ...(request.projectPath ? { projectPath: request.projectPath } : {}), signal: controller.signal, deferCleanup: (hook: () => void | Promise<void>) => {
    if (typeof hook !== 'function' || ++hookCount > 32) throw new AgentError('protocol_error');
    if (cleaning) void cleanup(hook).catch(() => {}); else hooks.push(hook);
  } });
  const cancel = () => controller.abort(abortError());
  request.signal?.addEventListener('abort', cancel, { once: true });
  if (request.signal?.aborted) cancel();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
  });
  const timer = setTimeout(() => controller.abort(new AgentError('timeout')), timeoutMs);
  let failure: unknown;
  try {
    const values = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return extension.list(context); }), aborted]);
    if (!Array.isArray(values) || values.length > 512) throw new AgentError('protocol_error');
    const seen = new Set<string>();
    result.skills = values.map(skill => {
      if (!isPlainRecord(skill) || !exactKeys(skill, ['skillId', 'name', 'description']) || !isSkillIdentity({ source: 'agent', backendId, skillId: skill.skillId }) || !publicText(skill.skillId, 4096) || skill.skillId !== skill.skillId.trim() || seen.has(skill.skillId) || !isSkillName(skill.name) || (skill.description !== '' && !publicText(skill.description, 4096))) throw new AgentError('protocol_error');
      seen.add(skill.skillId); return { skillId: skill.skillId, name: skill.name, description: skill.description as string };
    });
  } catch (error) { failure = controller.signal.aborted ? controller.signal.reason : agentError(error); }
  finally {
    clearTimeout(timer); request.signal?.removeEventListener('abort', cancel);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    cleaning = true; controller.abort();
    const settled = await Promise.allSettled(hooks.reverse().map(cleanup));
    if (failure === undefined && settled.some(outcome => outcome.status === 'rejected')) failure = new AgentError('protocol_error');
  }
  if (failure !== undefined) throw failure;
  return result;
}
