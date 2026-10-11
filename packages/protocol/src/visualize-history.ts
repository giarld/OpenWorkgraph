import type { Json } from './index.js';

/** The page package and node configuration belong to the Work Graph; interaction data does not. */
export function visualizeGraphContent(value: Json): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value['page']) return value;
  const { form: _form, state: _state, ...configuration } = value;
  return configuration;
}
