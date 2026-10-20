import type { AgentPlatform, InputSnapshot, Json } from '@openworkgraph/protocol';
import { sandboxMode } from '../execution-settings.js';
import type { AgentRegistry } from './registry.js';
import type { AgentExecutionSelection, LegacyAgentSelection } from './contracts.js';
import { AgentError } from './errors.js';
import { assertFrozenAgent } from './freezing.js';

/** The old wire format means Codex, regardless of today's workspace default.
 * Before sandboxMode was frozen, RuntimeBackend explicitly used read-only.
 * This is a format default, never the current workspace permission setting. */
export function resolveProductionSelection(registry: AgentRegistry, snapshot: InputSnapshot, details: Json, restoredRunStart = false): AgentExecutionSelection {
  const kind = typeof details === 'object' && details !== null && !Array.isArray(details) ? details.kind : undefined;
  if (snapshot.agent) { assertFrozenAgent(registry, snapshot, String(kind), restoredRunStart); return snapshot.agent; }
  if (snapshot.imageRoute?.type === 'api' || !snapshot.model) throw new AgentError('invalid_configuration');
  const plugin = registry.get('codex');
  const mode = typeof details === 'object' && details !== null && !Array.isArray(details) ? details.sandboxMode : undefined;
  let options: LegacyAgentSelection['options'];
  try { options = { sandboxMode: sandboxMode(mode === undefined ? 'read-only' : mode) }; } catch { throw new AgentError('invalid_configuration'); }
  const model = snapshot.model;
  if (typeof model.model !== 'string' || !model.model.trim() || model.model !== model.model.trim() || !(model.reasoningEffort === null || typeof model.reasoningEffort === 'string')) throw new AgentError('model_unavailable');
  const selection: LegacyAgentSelection = { legacy: true, backendId: 'codex', apiVersion: plugin.descriptor.apiVersion, schemaVersion: plugin.descriptor.configuration.version, implementationVersion: null, runtimeVersion: null, configRevision: null, options, model: structuredClone(model) };
  const available = registry.evaluate('codex', { kind: String(kind) as import('@openworkgraph/protocol').AgentRunKind, platform: process.platform as AgentPlatform, options, model, inputKinds: [...new Set([...snapshot.resources.map(resource => resource.kind), ...(snapshot.projectFiles ?? []).map(file => file.kind)])], resources: snapshot.resources, projectFiles: snapshot.projectFiles ?? [], visualize: kind === 'execution' && !!snapshot.features?.length, restoredRunStart });
  if (available.status !== 'available') throw new AgentError(available.reason ?? 'capability_unsupported');
  for (const skill of snapshot.skills ?? []) if (skill.source === 'agent' && skill.backendId !== 'codex' || skill.requiresConfiguration && !plugin.descriptor.capabilities.configuredSkills) throw new AgentError('capability_unsupported');
  return selection;
}
