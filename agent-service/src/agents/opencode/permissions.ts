import type { SandboxMode } from '@openworkgraph/protocol';
import { isAbsolute } from 'node:path';
import { AgentError } from '../errors.js';

export interface OpenCodePermissionRule { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
/** Native permission rules, not an OS sandbox. Read-only excludes arbitrary
 * command/delegation paths. Canonical resource assertions run inside the native
 * Permission service, including write aliases beneath Run directories. */
export function openCodePermissionRules(mode: SandboxMode, projectPath: string, runsPath: string): OpenCodePermissionRule[] {
  if (![projectPath, runsPath].every(path => isAbsolute(path) && !/[\x00-\x1f*?\[\]{}]/.test(path))) throw new AgentError('invalid_configuration');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw new AgentError('invalid_configuration');
  const rule = (action: string, resource: string, effect: OpenCodePermissionRule['effect']): OpenCodePermissionRule => ({ action, resource: resource.replaceAll(String.fromCharCode(92), '/'), effect });
  if (mode === 'danger-full-access') return [rule('*', '*', 'allow')];
  const rules = [rule('*', '*', 'deny'), rule('read', '*', 'allow'), rule('glob', '*', 'allow'), rule('grep', '*', 'allow'), rule('question', '*', 'allow'), rule('skill', '*', 'allow'), rule('webfetch', '*', 'ask'), rule('websearch', '*', 'ask'), rule('external_directory', '*', 'ask'), rule('external_directory', runsPath + '/*', 'allow')];
  rules.push(rule('edit', '*', mode === 'read-only' ? 'deny' : 'ask'));
  if (mode === 'workspace-write') rules.push(rule('edit', projectPath + '/*', 'allow'), rule('shell', '*', 'ask'), rule('subagent', '*', 'allow'));
  rules.push(rule('edit', runsPath + '/*', 'allow'));
  for (const name of ['query_run_history', 'read_run_context', 'validate_visualize_output', 'preview_visualize_output', 'inspect_visualize_preview', 'close_visualize_preview', 'run_skill_command']) rules.push(rule(name, '*', 'allow'));
  return rules;
}
