import type { BackendRunContext } from '../backend/types.js';
import { nodeGenerationGuidance, type NodeGenerationGuidanceOptions } from '../prompts/index.js';

/** Compatibility entry. All node kinds now receive the complete shared delivery contract. */
export function agentGuidance(context: BackendRunContext, options: NodeGenerationGuidanceOptions & { preferFinalAnswer?: boolean } = {}): string {
  // preferFinalAnswer is retained for source compatibility; textual-only requests use the same policy for every plugin.
  return nodeGenerationGuidance(context, options);
}
