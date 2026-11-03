import { parseJsonEventStream, jsonSchema } from 'ai';
import type { BuiltinAgentProtocol } from '@openworkgraph/protocol';
import { AgentError } from '../errors.js';

/** Only the official origin opts in. A model/connection display name is not
 * evidence that an arbitrary compatible server implements DeepSeek options. */
export function isBuiltinDeepSeek(endpoint: string): boolean {
  try { return new URL(endpoint).origin === 'https://api.deepseek.com'; } catch { return false; }
}
const efforts: Record<string, 'none' | 'low' | 'high' | 'max'> = {
  none: 'none', minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'high', max: 'max', ultra: 'max',
};
export function deepSeekEffort(value: unknown): 'none' | 'low' | 'high' | 'max' {
  if (value === undefined || value === null) return 'high';
  if (typeof value !== 'string' || !Object.hasOwn(efforts, value)) throw new AgentError('invalid_configuration');
  return efforts[value]!;
}
export function deepSeekOutputTokens(effort: string | null): number {
  const mapped = deepSeekEffort(effort);
  return mapped === 'none' ? 8192 : mapped === 'max' ? 131072 : 65536;
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
/** The SDK still serializes tools/media and parses responses. Only documented
 * vendor differences are translated at the plugin's private HTTP boundary. */
export function deepSeekRequest(body: ObjectValue, protocol: BuiltinAgentProtocol): ObjectValue {
  const result = { ...body };
  const effort = deepSeekEffort(protocol === 'responses' ? (object(body.reasoning) ? body.reasoning.effort : undefined) : body.reasoning_effort);
  if (protocol === 'chat-completions') {
    result.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
    result.reasoning_effort = effort;
    delete result.store;
  } else {
    result.reasoning = { effort }; result.store = false;
    // Open Responses preserves native reasoning content. DeepSeek does not
    // consume the optional Open Responses summary field.
    if (Array.isArray(body.input)) result.input = body.input.map(item => {
      if (!object(item) || item.type !== 'reasoning') return item;
      const { summary: _summary, ...reasoning } = item;
      return reasoning;
    });
  }
  if (effort !== 'none') for (const key of ['temperature', 'presence_penalty', 'frequency_penalty']) delete result[key];
  return result;
}

function reasoningItem(value: unknown): unknown {
  if (!object(value) || value.type !== 'reasoning') return value;
  // DeepSeek omits summary; the locked Open Responses provider expects it.
  return value.summary === undefined ? { ...value, summary: [] } : value;
}
function responseValue(value: unknown): unknown {
  if (!object(value)) return value;
  return { ...value, ...(Array.isArray(value.output) ? { output: value.output.map(reasoningItem) } : {}) };
}
function responseEvent(value: ObjectValue): ObjectValue {
  const event = { ...value };
  if (object(event.item)) event.item = reasoningItem(event.item);
  if (object(event.response)) event.response = responseValue(event.response);
  return event;
}

/** Fill the missing summary field only; the SDK handles native reasoning
 * events and round-trip serialization. No reasoning is exposed in the UI. */
export async function deepSeekResponse(response: Response): Promise<Response> {
  if (!response.ok || !response.body) return response;
  const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
  if (headers.get('content-type')?.includes('text/event-stream')) {
    const encoder = new TextEncoder();
    const body = parseJsonEventStream({ stream: response.body, schema: jsonSchema<ObjectValue>({ type: 'object' }, {
      validate: value => object(value) ? { success: true, value } : { success: false, error: new AgentError('protocol_error') },
    }) })
      .pipeThrough(new TransformStream({ transform(part, controller) {
        if (!part.success) throw new AgentError('protocol_error');
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(responseEvent(part.value)) + '\n\n'));
      } }));
    return new Response(body, { status: response.status, headers });
  }
  if (headers.get('content-type')?.includes('application/json')) return new Response(JSON.stringify(responseValue(await response.json())), { status: response.status, headers });
  return response;
}
