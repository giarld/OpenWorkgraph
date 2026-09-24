import { StdioRpc } from './stdio.js';
import { BackendError } from './types.js';
import type { BackendModel } from './models.js';
import { SERVICE_VERSION } from '@openworkgraph/protocol';
export const MINIMUM_CODEX_VERSION = '0.145.0';
export interface CapabilityEvidence { state: 'available' | 'unavailable' | 'unknown'; reason: string; checkedAt: string }
export interface BackendCapabilities { version: string; authenticated: boolean; models: BackendModel[]; textExecution: CapabilityEvidence; imageGeneration: CapabilityEvidence; skills: CapabilityEvidence; isolation: CapabilityEvidence }
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
export async function initialize(rpc: StdioRpc): Promise<string> {
  const result = await rpc.request('initialize', { clientInfo: { name: 'openworkgraph_agent_service', version: SERVICE_VERSION }, capabilities: { experimentalApi: true } });
  if (!supportedCodexVersion(result?.userAgent)) throw new BackendError('UNAVAILABLE', `Backend protocol requires Codex CLI >= ${MINIMUM_CODEX_VERSION}`);
  rpc.notify('initialized');
  const match = result.userAgent.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match![1]!;
}
export async function listModels(rpc: StdioRpc): Promise<BackendModel[]> {
  const models: BackendModel[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await rpc.request('model/list', { cursor, limit: 100, includeHidden: false });
    if (!Array.isArray(result?.data)) throw new BackendError('PROTOCOL', 'Invalid backend model catalog');
    for (const model of result.data) {
      if (model.hidden) continue;
      // Catalog ids are opaque: routed ids and their own effort lists come from the runtime.
      if (typeof model.model !== 'string' || !model.model.trim() || !Array.isArray(model.supportedReasoningEfforts)) throw new BackendError('PROTOCOL', 'Invalid backend model catalog entry');
      const efforts = model.supportedReasoningEfforts.map((e: any) => e.reasoningEffort);
      if (!efforts.every((e: unknown) => typeof e === 'string') || (model.defaultReasoningEffort !== null && !efforts.includes(model.defaultReasoningEffort))) throw new BackendError('PROTOCOL', 'Invalid backend reasoning catalog');
      if (!models.some(m => m.id === model.model)) models.push({ id: model.model, reasoningEfforts: efforts, defaultReasoningEffort: model.defaultReasoningEffort });
    }
    if (result.nextCursor == null) return models;
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new BackendError('PROTOCOL', 'Invalid model pagination');
    cursor = result.nextCursor; cursors.add(result.nextCursor);
  }
  throw new BackendError('PROTOCOL', 'Model catalog exceeded page limit');
}
/** Read-only: never login/start, refresh, write configuration, or expose account identity. */
export async function probeCapabilities(rpc: StdioRpc): Promise<BackendCapabilities> {
  const version = await initialize(rpc); const account = await rpc.request('account/read', { refreshToken: false }); const checkedAt = new Date().toISOString();
  const authenticated = account?.account?.type === 'chatgpt';
  const unknown = (reason: string): CapabilityEvidence => ({ state: 'unknown', reason, checkedAt });
  return { version, authenticated, models: authenticated ? await listModels(rpc) : [], textExecution: unknown('Catalog/login alone do not prove an inference succeeds'), imageGeneration: unknown('Image input is not image generation; no real generation proof'), skills: unknown('Discovery is not proof of safe execution in this service'), isolation: unknown('Requires platform-specific negative boundary tests and tool inventory verification') };
}
