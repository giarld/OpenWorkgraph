import type { BackendRunContext } from './types.js';
import { referenceGuidance } from '../prompts/references.js';

/** Codex native tool instructions; product generation/delivery rules live in prompts/. */
export function codexNativeGuidance(context: BackendRunContext): string {
  if (context.kind !== 'image_generation') return '';
  return [
    '$imagegen Use the built-in image_gen tool. Do not use the Image API or a CLI fallback. Copy the selected image from the built-in Codex image location into the Output directory.',
    'Pass supported image settings to image_gen. If a setting is not directly supported, preserve its intent in the generation prompt instead of silently dropping it.',
    codexImageReferenceGuidance(context),
  ].filter(Boolean).join('\n');
}

function codexImageReferenceGuidance(context: BackendRunContext): string {
  if (context.kind !== 'image_generation' || !context.resources?.length) return '';
  return 'Pass images to image_gen referenced_image_paths in their reference-list order and explicitly map each image attachment to its original reference number in the image generation prompt. If the built-in tool cannot read the reference, report failure rather than generating an unrelated image.';
}

/** Compatibility helper for callers that previously obtained references from the Codex adapter. */
export function codexReferenceGuidance(context: BackendRunContext, options: { nativeImageGeneration?: boolean; commandSandbox?: boolean } = {}): string {
  const references = referenceGuidance(context, options);
  return references ? references + (options.nativeImageGeneration === false ? '' : codexImageReferenceGuidance(context)) : '';
}
