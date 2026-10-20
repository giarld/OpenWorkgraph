import type { Json } from './index.js';

/** Browser-local generation settings. Only an accepted Run writes these to a node. */
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
