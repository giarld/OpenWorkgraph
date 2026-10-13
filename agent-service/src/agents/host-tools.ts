import type { Json } from '@openworkgraph/protocol';
import type { RunContextRequest } from '../run-context.js';
import type { BackendCallbacks } from '../backend/types.js';
import { ServiceError } from '../errors.js';

export interface AgentHostTool { version: 1; name: string; description: string; inputSchema: Json }
export interface AgentToolCall { callId: string; runId: string; attemptId: string; name: string; arguments: unknown }
export type AgentToolResult = { callId: string; success: true; content: string } | { callId: string; success: false; code: string; content: string };

// Snapshot JSON data before deferring callbacks. Do not invoke plugin getters or
// toJSON hooks, or let key order/mutation change a call's idempotent identity.
function snapshotJson(value: unknown, depth = 0): Json {
  if (depth > 32) throw new ServiceError('INVALID_REQUEST', 'Host tool arguments are too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value as object), length = descriptors.length!.value as number;
    if (length > 16384) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Host tool arguments are too large');
    if (Object.getOwnPropertySymbols(value).length || Object.keys(descriptors).length !== length + 1)
      throw new ServiceError('INVALID_REQUEST', 'Host tool arguments must be JSON data');
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new ServiceError('INVALID_REQUEST', 'Host tool arguments must be JSON data');
      return snapshotJson(descriptor.value, depth + 1);
    });
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new ServiceError('INVALID_REQUEST', 'Host tool arguments must be JSON data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new ServiceError('INVALID_REQUEST', 'Host tool arguments must be JSON data');
  const entries = Object.keys(descriptors).sort().map(key => {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new ServiceError('INVALID_REQUEST', 'Host tool arguments must be JSON data');
    return [key, snapshotJson(descriptor.value, depth + 1)];
  });
  return Object.fromEntries(entries);
}

/** Closed tool inventory. Each callback is already bound to a host-authorized Run. */
export class AgentHostTools {
  private readonly observed = new Map<string, { arguments: string; result: Promise<AgentToolResult> }>();
  constructor(readonly runId: string, readonly attemptId: string, private readonly callbacks: BackendCallbacks, private readonly active: () => boolean, private readonly maxResultBytes = 65536) {
    if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1) throw new ServiceError('INVALID_REQUEST', 'Invalid host tool result budget');
  }
  describe(): AgentHostTool[] {
    const tools: AgentHostTool[] = [];
    if (this.callbacks.queryHistory) tools.push({ version: 1, name: 'query_run_history', description: 'Search retained history in this Run project.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false } });
    if (this.callbacks.readRunContext) tools.push({ version: 1, name: 'read_run_context', description: 'Read exact Run content in this project: summary, snapshot, history, outputs, or an immutable published output. Pages contain up to 4000 JSON-text characters; continue with nextOffset. output requires outputKey; other sections forbid it.', inputSchema: { type: 'object', properties: { runId: { type: 'string', minLength: 1, maxLength: 200 }, section: { enum: ['summary', 'snapshot', 'history', 'outputs', 'output'] }, outputKey: { type: 'string', minLength: 1, maxLength: 1024 }, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, required: ['runId', 'section'], additionalProperties: false, allOf: [{ if: { properties: { section: { const: 'output' } }, required: ['section'] }, then: { required: ['outputKey'] }, else: { not: { required: ['outputKey'] } } }] } });
    if (this.callbacks.validateVisualizeOutput) tools.push({ version: 1, name: 'validate_visualize_output', description: 'Read-only preflight of this Run Output; never publishes.', inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['path'], additionalProperties: false } });
    return tools;
  }
  call(call: AgentToolCall): Promise<AgentToolResult> {
    if (!call || call.runId !== this.runId || call.attemptId !== this.attemptId || !this.active() || typeof call.callId !== 'string' || !call.callId || call.callId.length > 200) return Promise.reject(new ServiceError('CONFLICT', 'Stale or foreign host tool call'));
    let args: Json, body: string;
    try {
      if (typeof call.name !== 'string') throw new ServiceError('INVALID_REQUEST', 'Invalid host tool name');
      args = snapshotJson(call.arguments);
      body = JSON.stringify({ name: call.name, arguments: args });
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'PAYLOAD_TOO_LARGE') return Promise.reject(new ServiceError('PAYLOAD_TOO_LARGE', 'Host tool arguments are too large'));
      return Promise.reject(new ServiceError('INVALID_REQUEST', 'Host tool arguments must be JSON data'));
    }
    if (Buffer.byteLength(body) > 16384) return Promise.reject(new ServiceError('PAYLOAD_TOO_LARGE', 'Host tool arguments are too large'));
    const prior = this.observed.get(call.callId);
    if (prior) { if (prior.arguments !== body) return Promise.reject(new ServiceError('IDEMPOTENCY_CONFLICT', 'Host tool call identity conflict')); return prior.result; }
    if (this.observed.size >= 256) return Promise.reject(new ServiceError('INPUT_BUDGET_EXCEEDED', 'Host tool retention limit reached'));
    // Register before invoking callbacks, including callbacks that reenter call().
    const request = { ...call, arguments: args };
    const result = Promise.resolve().then(() => this.invoke(request));
    this.observed.set(call.callId, { arguments: body, result }); return result;
  }
  private async invoke(call: AgentToolCall): Promise<AgentToolResult> {
    if (!this.active()) throw new ServiceError('CONFLICT', 'Run changed before host tool execution');
    const args = call.arguments;
    let result: AgentToolResult;
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ServiceError('INVALID_REQUEST', 'Host tool arguments must be an object');
      const data = args as Record<string, unknown>; let content: string;
      if (call.name === 'query_run_history' && this.callbacks.queryHistory) {
        if (Object.keys(data).some(key => key !== 'query') || typeof data.query !== 'string' || !data.query.trim() || data.query.length > 2000) throw new ServiceError('INVALID_REQUEST', 'Invalid history query');
        content = await this.callbacks.queryHistory(data.query);
      } else if (call.name === 'read_run_context' && this.callbacks.readRunContext) {
        if (Object.keys(data).some(key => !['runId', 'section', 'outputKey', 'offset'].includes(key)) || typeof data.runId !== 'string' || !data.runId || data.runId.length > 200 || typeof data.section !== 'string' || !['summary', 'snapshot', 'history', 'outputs', 'output'].includes(data.section) ||
            (data.section === 'output' ? typeof data.outputKey !== 'string' || !data.outputKey || data.outputKey.length > 1024 : data.outputKey !== undefined) ||
            (data.offset !== undefined && (!Number.isSafeInteger(data.offset) || Number(data.offset) < 0))) throw new ServiceError('INVALID_REQUEST', 'Invalid frozen context request');
        content = await this.callbacks.readRunContext(data as unknown as RunContextRequest);
      } else if (call.name === 'validate_visualize_output' && this.callbacks.validateVisualizeOutput) {
        if (Object.keys(data).some(key => key !== 'path') || typeof data.path !== 'string' || !data.path.trim() || data.path.length > 512) throw new ServiceError('INVALID_REQUEST', 'Invalid Output preflight path');
        content = JSON.stringify(await this.callbacks.validateVisualizeOutput(data.path));
      } else throw new ServiceError('NOT_IMPLEMENTED', 'Host tool capability is not available');
      if (typeof content !== 'string') throw new ServiceError('INTERNAL_ERROR', 'Invalid host tool result');
      if (Buffer.byteLength(content) > this.maxResultBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Host tool result exceeds delivery budget; request a smaller page');
      result = { callId: call.callId, success: true, content };
    } catch (error) {
      // Plugin/native raw errors are not public tool content.
      result = { callId: call.callId, success: false, code: error instanceof ServiceError ? error.code : 'INTERNAL_ERROR', content: 'Host tool call failed' };
    }
    // Expired calls reject instead of delivering even a failure result to a new
    // attempt. Check both successful and failed callbacks at the delivery boundary.
    if (!this.active()) throw new ServiceError('CONFLICT', 'Run changed before host tool result delivery');
    return result;
  }
}
