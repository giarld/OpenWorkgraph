import { StdioRpc } from './stdio.js';
import { BackendError } from './types.js';
import type { BackendModel } from './models.js';
import { SERVICE_VERSION } from '@openworkgraph/protocol';
export const MINIMUM_CODEX_VERSION = '0.145.0';
export interface CapabilityEvidence { state: 'available' | 'unavailable' | 'unknown'; reason: string; checkedAt: string }
export interface BackendCapabilities { version: string; models: BackendModel[]; textExecution: CapabilityEvidence; imageGeneration: CapabilityEvidence; skills: CapabilityEvidence; isolation: CapabilityEvidence }
function supportedCodexVersion(userAgent: unknown): boolean {
  if (typeof userAgent !== 'string') return false;
  const match = userAgent.match(/\/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:[+\s(]|$)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  const minimum = MINIMUM_CODEX_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! !== minimum[index]!) return actual[index]! > minimum[index]!;
  }
  return !match[4];
}
/** Mandatory wire handshake only: no login, version gate, MCP or execution self-check. */
export async function connect(rpc: StdioRpc): Promise<any> {
  const result = await rpc.request('initialize', { clientInfo: { name: 'openworkgraph_agent_service', version: SERVICE_VERSION }, capabilities: { experimentalApi: true } });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new BackendError('PROTOCOL', 'Invalid backend handshake', { reason: 'invalid_handshake', method: 'initialize' });
  rpc.notify('initialized');
  return result;
}
/** Execution compatibility is checked when starting work, independently of catalog reads. */
export async function initialize(rpc: StdioRpc): Promise<string> {
  const result = await connect(rpc);
  const match = typeof result.userAgent === 'string' ? result.userAgent.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) : null;
  if (!match) throw new BackendError('PROTOCOL', 'Invalid backend version response', { reason: 'invalid_handshake', method: 'initialize' });
  if (!supportedCodexVersion(result.userAgent)) throw new BackendError('UNAVAILABLE', `Backend protocol requires Codex CLI >= ${MINIMUM_CODEX_VERSION}`, { reason: 'unsupported_version', method: 'initialize', version: match[1]!.slice(0,64) });
  return match![1]!;
}
export async function listModels(rpc: StdioRpc): Promise<BackendModel[]> {
  const models: BackendModel[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await rpc.request('model/list', { cursor, limit: 100, includeHidden: false });
    if (!Array.isArray(result?.data)) throw new BackendError('PROTOCOL', 'Invalid backend model catalog', { reason: 'invalid_catalog', method: 'model/list' });
    for (const model of result.data) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) throw new BackendError('PROTOCOL', 'Invalid backend model catalog entry', { reason: 'invalid_catalog', method: 'model/list' });
      if (model.hidden) continue;
      // Catalog ids are opaque: routed ids and their own effort lists come from the runtime.
      if (typeof model.model !== 'string' || !model.model.trim() || !Array.isArray(model.supportedReasoningEfforts)) throw new BackendError('PROTOCOL', 'Invalid backend model catalog entry', { reason: 'invalid_catalog', method: 'model/list' });
      const efforts = model.supportedReasoningEfforts.map((e: any) => e?.reasoningEffort);
      if (!efforts.every((e: unknown) => typeof e === 'string') || (model.defaultReasoningEffort !== null && !efforts.includes(model.defaultReasoningEffort))) throw new BackendError('PROTOCOL', 'Invalid backend reasoning catalog', { reason: 'invalid_catalog', method: 'model/list' });
      if (!models.some(m => m.id === model.model)) models.push({ id: model.model, reasoningEfforts: efforts, defaultReasoningEffort: model.defaultReasoningEffort });
    }
    if (result.nextCursor == null) return models;
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new BackendError('PROTOCOL', 'Invalid model pagination', { reason: 'invalid_catalog', method: 'model/list' });
    cursor = result.nextCursor; cursors.add(result.nextCursor);
  }
  throw new BackendError('PROTOCOL', 'Model catalog exceeded page limit', { reason: 'invalid_catalog', method: 'model/list' });
}
/** Read-only: never read accounts, login/start, refresh, or write configuration. */
export async function probeCapabilities(rpc: StdioRpc): Promise<BackendCapabilities> {
  const version = await initialize(rpc); const checkedAt = new Date().toISOString();
  const unknown = (reason: string): CapabilityEvidence => ({ state: 'unknown', reason, checkedAt });
  return { version, models: await listModels(rpc), textExecution: unknown('Catalog alone does not prove an inference succeeds'), imageGeneration: unknown('Image input is not image generation; no real generation proof'), skills: unknown('Discovery is not proof of safe execution in this service'), isolation: unknown('Requires platform-specific negative boundary tests and tool inventory verification') };
}
