import type { BackendRunContext } from './types.js';
import { referenceGuidance } from '../prompts/references.js';

/** Compatibility helper for reference instructions. */
export function codexReferenceGuidance(context: BackendRunContext, options: { nativeImageGeneration?: boolean; commandSandbox?: boolean } = {}): string {
  return referenceGuidance(context, options);
}
