import type { Json } from './index.js';

/** Local generation settings; accepted runs persist them, explicit editor close shares prompt fields. */
export const RUN_INPUT_FIELDS = ['prompt', 'skillReferences', 'features', 'modelOverride', 'agentModelOverride', 'imageRoute'] as const;
export type RunInput = Partial<Record<typeof RUN_INPUT_FIELDS[number], Json>>;
export function parseRunInput(value: unknown): RunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !(RUN_INPUT_FIELDS as readonly string[]).includes(key))) throw Error('Invalid run input fields');
  const input = value as RunInput;
  if (input.prompt !== undefined && typeof input.prompt !== 'string') throw Error('Invalid run prompt');
  for (const key of ['skillReferences', 'features'] as const) if (input[key] !== undefined && !Array.isArray(input[key])) throw Error('Invalid run references');
  for (const key of ['modelOverride', 'agentModelOverride', 'imageRoute'] as const) if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'object' || Array.isArray(input[key]))) throw Error('Invalid run model settings');
  return input;
}
export function mergeRunInput(content: Json, input?: RunInput): Record<string, Json> {
  return { ...(content && typeof content === 'object' && !Array.isArray(content) ? content : {}), ...input };
}

/** Unsubmitted execution members, keyed by node ID in the target's ancestor scope. */
export type NodeInputDrafts = Record<string, RunInput>;
export function parseNodeInputDrafts(value: unknown): NodeInputDrafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid execution input drafts');
  return Object.fromEntries(Object.entries(value).map(([id, fields]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid execution input node');
    return [id, parseRunInput(fields)];
  }));
}
