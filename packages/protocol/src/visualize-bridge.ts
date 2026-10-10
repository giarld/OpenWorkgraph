import type { Json } from './index.js';
import type { VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeCapabilityUpdate, VisualizeExpectedRevisions, VisualizeProtocolError } from './visualize.js';
import { VISUALIZE_BRIDGE_VERSION, VISUALIZE_ERROR_CODES, isVisualizeFeatureSelection } from './visualize.js';
import { checkedVisualizeJson, validateVisualizeSize, VisualizeValidationError } from './visualize-validation.js';
import { isSkillName } from './skills.js';

export const VISUALIZE_BRIDGE_REQUEST_BYTES = 2_097_152;
export const VISUALIZE_BRIDGE_RESPONSE_BYTES = 50_331_648;
const methods = ['initialize', 'readInputs', 'saveState', 'updateForm', 'createSuccessors', 'requestLayout', 'exportAsset'];
const revisionKeys = ['pageRevision', 'formVersion', 'stateVersion', 'inputVersion', 'executionRevision', 'layoutRevision'];
const fail = (message: string): never => { throw new VisualizeValidationError('INVALID_REQUEST', message); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('Missing or unsupported message fields');
}
function text(value: unknown, limit = 128): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit; }
function integer(value: unknown, minimum = 0): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum; }
export function validateVisualizeCapabilityUpdate(value: unknown): VisualizeCapabilityUpdate {
  const update = record(checkedVisualizeJson(value, 4096));
  keys(update, ['channel', 'version', 'sessionId', 'nodeId', 'type', 'capabilities']);
  if (update.channel !== 'openworkgraph.visualize' || update.version !== VISUALIZE_BRIDGE_VERSION || update.type !== 'capabilities' || !text(update.sessionId) || !text(update.nodeId)) fail('Invalid capability identity');
  const capabilities = record(update.capabilities); keys(capabilities, ['readOnly', 'online', 'canCreateSuccessors'], ['canExportAssets']);
  if (Object.values(capabilities).some(value => typeof value !== 'boolean')) fail('Invalid capabilities');
  return update as unknown as VisualizeCapabilityUpdate;
}
export function validateVisualizeRevisions(value: unknown): VisualizeExpectedRevisions {
  const result = record(value); keys(result, revisionKeys);
  if (revisionKeys.some(key => !integer(result[key]))) fail('Invalid expected revisions');
  return result as unknown as VisualizeExpectedRevisions;
}
function identity(value: Record<string, unknown>, type: string): void {
  if (value.channel !== 'openworkgraph.visualize' || value.type !== type || typeof value.method !== 'string' || !methods.includes(value.method)) fail('Unknown bridge channel, type or method');
  if (value.version !== VISUALIZE_BRIDGE_VERSION) throw new VisualizeValidationError('SCHEMA_UNSUPPORTED', 'Unsupported bridge version');
  if (!text(value.sessionId) || !text(value.nodeId) || !text(value.requestId) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(String(value.requestId))) fail('Invalid bridge identity');
}
/** Copies only bounded plain JSON before reading fields, including nested params. */
export function validateVisualizeBridgeRequest(value: unknown): VisualizeBridgeRequest {
  const request = record(checkedVisualizeJson(value, VISUALIZE_BRIDGE_REQUEST_BYTES));
  keys(request, ['channel', 'version', 'sessionId', 'nodeId', 'requestId', 'type', 'method', 'expected', 'params']);
  identity(request, 'request'); validateVisualizeRevisions(request.expected);
  const params = record(request.params);
  switch (request.method) {
    case 'exportAsset':
      keys(params, ['name', 'mime', 'bytes']);
      if (!text(params.name, 512) || !(params.name as string).trim() || /[\u0000-\u001f\u007f/\\]/.test(params.name as string) || !text(params.mime, 128) || !/^[a-zA-Z0-9.+-]+[/][a-zA-Z0-9.+-]+$/.test(params.mime as string) || !integer(params.bytes, 1)) fail('Invalid asset metadata');
      if ((params.bytes as number) > 300 * 1024 * 1024) throw new VisualizeValidationError('PAYLOAD_TOO_LARGE', 'Asset exceeds 300 MB');
      break;
    case 'initialize': keys(params, []); break;
    case 'readInputs': keys(params, ['refresh']); if (typeof params.refresh !== 'boolean') fail('Invalid refresh'); break;
    case 'saveState': keys(params, ['state']); checkedVisualizeJson(params.state); break;
    case 'updateForm': keys(params, ['form']); record(checkedVisualizeJson(params.form)); break;
    case 'requestLayout': validateVisualizeSize(params, 'manual', { width: 1e9, height: 1e9 }); break;
    case 'createSuccessors': {
      keys(params, ['successors'], ['form']); if (Object.hasOwn(params, 'form')) record(checkedVisualizeJson(params.form));
      if (!Array.isArray(params.successors) || !params.successors.length || params.successors.length > 32) fail('Invalid successor count');
      for (const value of params.successors as unknown[]) {
        const successor = record(value);
        keys(successor, ['type', successor.type === 'text' ? 'text' : 'prompt'], ['title']);
        if (typeof successor.type !== 'string' || !['text', 'image', 'execution'].includes(successor.type) || successor.title !== undefined && !text(successor.title, 1024)) fail('Invalid successor type/title');
        if (successor.type === 'text') { if (typeof successor.text !== 'string' || successor.text.length > 1_048_576) fail('Invalid successor text'); continue; }
        const prompt = record(successor.prompt); keys(prompt, ['text', 'skillReferences', 'features', 'files']);
        if (typeof prompt.text !== 'string' || prompt.text.length > 1_048_576 || !Array.isArray(prompt.skillReferences) || prompt.skillReferences.length > 64 || !Array.isArray(prompt.features) || prompt.features.length > 1 || prompt.features.some(feature => !isVisualizeFeatureSelection(feature)) || !Array.isArray(prompt.files) || prompt.files.length > 64) fail('Invalid successor prompt');
        for (const value of prompt.skillReferences as unknown[]) {
          const skill = record(value); keys(skill, ['skillId', 'source', 'name', 'start', 'end']);
          if (!text(skill.skillId, 256) || typeof skill.source !== 'string' || !['openworkgraph', 'codex'].includes(skill.source) || !isSkillName(skill.name) || !integer(skill.start) || !integer(skill.end) || Number(skill.end) <= Number(skill.start) || Number(skill.end) > (prompt.text as string).length || (prompt.text as string).slice(Number(skill.start), Number(skill.end)) !== '$' + skill.name) fail('Invalid skill identity or mention range');
        }
        for (const value of prompt.files as unknown[]) { const file = record(value); keys(file, ['relativePath']); if (!text(file.relativePath, 4096) || /^(?:[/\\]|[A-Za-z]:)/.test(file.relativePath) || file.relativePath.split(/[/\\]/).some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f]/.test(file.relativePath)) fail('Invalid project-relative file identity'); }
      }
      break;
    }
  }
  return request as unknown as VisualizeBridgeRequest;
}
function snapshot(value: unknown, form: boolean): void {
  const result = record(value); keys(result, form ? ['pageRevision', 'schemaVersion', 'version', 'data', 'resource'] : ['pageRevision', 'version', 'data']);
  if (!integer(result.pageRevision, 1) || !integer(result.version, 1)) fail('Invalid snapshot version');
  if (form) {
    if (!integer(result.schemaVersion, 1)) fail('Invalid form schema version'); record(result.data);
    const resource = record(result.resource); keys(resource, ['resourceId', 'resourceVersion']); if (!text(resource.resourceId) || !integer(resource.resourceVersion, 1)) fail('Invalid form resource');
  }
}
function inputs(value: unknown): void {
  const result = record(value); keys(result, ['version', 'digest', 'inputs']);
  if (!integer(result.version, 1) || typeof result.digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.digest) || !Array.isArray(result.inputs)) fail('Invalid input snapshot');
}
function protocolError(value: unknown): void {
  const error = record(value); keys(error, ['code', 'message', 'retryable'], ['fields']);
  if (!VISUALIZE_ERROR_CODES.includes(error.code as VisualizeProtocolError['code']) || !text(error.message, 2000) || typeof error.retryable !== 'boolean') fail('Invalid protocol error');
  if (error.fields !== undefined) {
    if (!Array.isArray(error.fields) || error.fields.length > 100) fail('Invalid field errors');
    for (const value of error.fields as unknown[]) { const field = record(value); keys(field, ['path', 'keyword', 'message']); if (typeof field.path !== 'string' || field.path.length > 4096 || !text(field.keyword) || !text(field.message, 2000)) fail('Invalid field error'); }
  }
}
export function validateVisualizeBridgeResponse(value: unknown): VisualizeBridgeResponse {
  const response = record(checkedVisualizeJson(value, VISUALIZE_BRIDGE_RESPONSE_BYTES));
  keys(response, ['channel', 'version', 'sessionId', 'nodeId', 'requestId', 'type', 'method', 'ok', response.ok === true ? 'result' : 'error']);
  identity(response, 'response');
  if (response.ok === false) protocolError(response.error);
  else if (response.ok === true) {
    const result = record(response.result);
    switch (response.method) {
      case 'initialize': {
        keys(result, ['pageRevision', 'form', 'state', 'inputs', 'inputsChanged', 'revisions', 'theme', 'locale', 'viewport', 'capabilities']);
        snapshot(result.form, true); snapshot(result.state, false); inputs(result.inputs); validateVisualizeRevisions(result.revisions);
        if (!integer(result.pageRevision, 1) || typeof result.inputsChanged !== 'boolean' || !text(result.locale)) fail('Invalid initialization');
        const theme = record(result.theme); keys(theme, ['mode', 'tokens']); if (typeof theme.mode !== 'string' || !['light', 'dark'].includes(theme.mode) || Object.values(record(theme.tokens)).some(value => typeof value !== 'string')) fail('Invalid theme');
        const viewport = record(result.viewport); keys(viewport, ['width', 'height']); if (![viewport.width, viewport.height].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) fail('Invalid viewport');
        const capabilities = record(result.capabilities); keys(capabilities, ['readOnly', 'online', 'canCreateSuccessors'], ['canExportAssets']); if (Object.values(capabilities).some(value => typeof value !== 'boolean')) fail('Invalid capabilities');
        break;
      }
      case 'readInputs': keys(result, ['inputs', 'inputsChanged'], ['inputError']); inputs(result.inputs); if (typeof result.inputsChanged !== 'boolean') fail('Invalid inputsChanged'); if (result.inputError !== undefined) protocolError(result.inputError); break;
      case 'saveState': keys(result, ['state', 'revisions']); snapshot(result.state, false); validateVisualizeRevisions(result.revisions); break;
      case 'updateForm': keys(result, ['form', 'revisions']); snapshot(result.form, true); validateVisualizeRevisions(result.revisions); break;
      case 'createSuccessors': keys(result, ['nodeIds', 'edgeIds', 'form', 'revisions']); snapshot(result.form, true); validateVisualizeRevisions(result.revisions); if (![result.nodeIds, result.edgeIds].every(value => Array.isArray(value) && value.length <= 32 && value.every(id => text(id)))) fail('Invalid successor identities'); break;
      case 'exportAsset':
        keys(result, ['assetId', 'assetVersion', 'resourceId', 'resourceVersion', 'nodeId', 'edgeId', 'mime', 'bytes', 'revisions']);
        if (!['assetId', 'resourceId', 'nodeId', 'edgeId'].every(key => text(result[key])) || !integer(result.assetVersion, 1) || !integer(result.resourceVersion, 1) || !integer(result.bytes, 1) || !text(result.mime, 128)) fail('Invalid exported asset');
        validateVisualizeRevisions(result.revisions); break;
      case 'requestLayout': keys(result, ['size', 'layoutRevision']); validateVisualizeSize(result.size, 'manual', { width: 1e9, height: 1e9 }); if (!integer(result.layoutRevision)) fail('Invalid layout revision'); break;
    }
  } else fail('Invalid response status');
  return response as unknown as VisualizeBridgeResponse;
}
/** Internal exceptions never expose filesystem paths, credentials or stacks to pages. */
export function visualizeProtocolError(error: unknown): VisualizeProtocolError {
  if (error instanceof VisualizeValidationError) return { code: error.code, message: error.message.slice(0, 2000), retryable: false, ...(error.fields.length ? { fields: error.fields } : {}) };
  const value = error as { code?: string; message?: string; retryable?: boolean; details?: { visualizeCode?: string; fields?: unknown } } | null;
  const code = value?.details?.visualizeCode ?? value?.code;
  if (VISUALIZE_ERROR_CODES.includes(code as VisualizeProtocolError['code'])) {
    const result = { code, message: value?.message?.slice(0, 2000) || '页面操作失败。', retryable: value?.retryable === true, ...(value?.details?.fields ? { fields: value.details.fields } : {}) };
    try { protocolError(result); return result as VisualizeProtocolError; } catch { /* Unexpected error details are not public data. */ }
  }
  const mapped = ['UNAUTHENTICATED', 'SESSION_REVOKED', 'SERVICE_MISMATCH', 'LIFECYCLE_CANCELLED'].includes(code ?? '') ? 'SESSION_EXPIRED' : code === 'NODE_LOCKED' || code === 'PROJECT_INACTIVE' ? 'READ_ONLY' : code === 'NOT_FOUND' ? 'RESOURCE_UNAVAILABLE' : code === 'INPUT_BUDGET_EXCEEDED' ? 'PAYLOAD_TOO_LARGE' : undefined;
  return mapped ? { code: mapped, message: '当前页面操作不可用。', retryable: false } : { code: 'INTERNAL_ERROR', message: '页面操作未能完成。', retryable: false };
}
