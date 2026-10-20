import { isSkillIdentity, normalizeSkillIdentity } from '@openworkgraph/protocol';
import type { AgentPlatform, InputSnapshot, Json } from '@openworkgraph/protocol';
import { canonicalJson } from '../persistence/repositories.js';
import { AgentError } from './errors.js';
import type { AgentRegistry } from './registry.js';

/** Host input and plugin compatibility never re-read enabled/default/settings
 * revisions for an already accepted Run. */
export function assertFrozenAgent(registry: AgentRegistry, snapshot: InputSnapshot, kind: string, restoredRunStart = false, platform: AgentPlatform = process.platform as AgentPlatform): void {
  const frozen = snapshot.agent; if (!frozen) return;
  registry.validateFrozen(frozen, platform);
  if (!Array.isArray(snapshot.resources) || snapshot.projectFiles !== undefined && !Array.isArray(snapshot.projectFiles)) throw new AgentError('invalid_configuration');
  if (!['execution', 'text_generation', 'image_generation', 'visualize_generation'].includes(kind) || snapshot.imageRoute?.type === 'api') throw new AgentError('capability_unsupported');
  if (!snapshot.model || canonicalJson(snapshot.model as unknown as Json) !== canonicalJson(frozen.model as unknown as Json)) throw new AgentError('invalid_configuration');
  registry.assertFrozen(frozen, { kind: kind as import('@openworkgraph/protocol').AgentRunKind, platform, options: frozen.options, inputKinds: [...new Set([...snapshot.resources.map(input => input.kind), ...(snapshot.projectFiles ?? []).map(input => input.kind)])], resources: snapshot.resources, skills: snapshot.skills ?? [], projectFiles: snapshot.projectFiles ?? [], visualize: kind === 'execution' && !!snapshot.features?.length, restoredRunStart });
  const descriptor = registry.get(frozen.backendId).descriptor;
  if (snapshot.skills !== undefined && !Array.isArray(snapshot.skills)) throw new AgentError('invalid_configuration');
  for (const skill of snapshot.skills ?? []) {
    if (!isSkillIdentity(skill) || typeof skill.requiresConfiguration !== 'boolean') throw new AgentError('invalid_configuration');
    const identity = normalizeSkillIdentity(skill);
    if (skill.requiresConfiguration && !descriptor.capabilities.configuredSkills || identity.source === 'agent' && (identity.backendId !== frozen.backendId || !descriptor.capabilities.nativeSkills)) throw new AgentError('capability_unsupported');
  }
}
