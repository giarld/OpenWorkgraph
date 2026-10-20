import type { BackendRunContext } from '../backend/types.js';
import { commonGenerationGuidance } from './common.js';
import { executionDeliveryGuidance, DEVELOPMENT_CHANGED_FILES_GUIDANCE } from './execution.js';
import { textGenerationGuidance } from './text.js';
import { imageGenerationGuidance } from './image.js';
import { visualizeGenerationGuidance } from './visualize.js';
import { referenceGuidance, upstreamGuidance } from './references.js';

export interface NodeGenerationGuidanceOptions {
  /** Whether delivery may propose a title; the host still decides whether to apply it. */
  generateTitle?: boolean;
}

/** Pure product instructions. Native tools, transport and backend policy belong to plugins. */
export function nodeGenerationGuidance(context: BackendRunContext, options: NodeGenerationGuidanceOptions = {}): string {
  let generation: string;
  switch (context.kind) {
    case 'execution':
      generation = [
        'For a simple textual request, answer directly without tools or a manifest. For development work, the final answer must include the normal response, actual changes as unified diffs, and actual validation or limitations.',
        DEVELOPMENT_CHANGED_FILES_GUIDANCE,
        'The following file publication instructions apply when producing requested content files or Work Graph output nodes, including media generated through a skill:',
        executionDeliveryGuidance(options.generateTitle ?? true),
      ].join('\n');
      break;
    case 'text_generation': generation = textGenerationGuidance(); break;
    case 'image_generation': generation = imageGenerationGuidance(context); break;
    case 'visualize_generation': generation = ''; break;
    default: { const exhaustive: never = context.kind; throw new Error('Unsupported node generation kind: ' + exhaustive); }
  }
  return [commonGenerationGuidance(context), generation, visualizeGenerationGuidance(context),
    referenceGuidance(context, { commandSandbox: false }), upstreamGuidance(context)].filter(Boolean).join('\n');
}

export { nodeTitleGuidance } from './title.js';
export { executionDeliveryGuidance, DEVELOPMENT_CHANGED_FILES_GUIDANCE } from './execution.js';
export { referenceGuidance, upstreamGuidance } from './references.js';
export { visualizeGenerationGuidance, VISUALIZE_NODE_TITLE_GUIDANCE } from './visualize.js';
