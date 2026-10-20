import type { BackendRunContext } from '../backend/types.js';

export function imageGenerationGuidance(context: BackendRunContext): string {
  return [
    'Generate one image for the requested image node. Save the selected image in the Output directory as a real file; an inline preview or link is not a deliverable. Also write one nonempty Markdown description (.md) in the Output directory, beginning with a concise heading (# Title) of at most 32 characters. The Work Graph uses that heading as the generated image node title, capped at 32 characters.',
    'Write manifest.json there with an outputs array and no version field containing exactly one image and exactly one Markdown entry. Each entry must have a unique outputKey, a relative path, exact mime (image/png, image/jpeg, image/webp, or image/gif for the image; text/markdown for the description), actual byte count, and lowercase SHA-256 of the saved bytes. Verify both files and the manifest before claiming delivery. Write all text as UTF-8 without BOM. If image generation is unavailable, report that failure instead of claiming an image was created.',
    context.imageOptions ? 'Image settings requested by the user: quality=' + (context.imageOptions.quality ?? 'auto') + ', size=' + (context.imageOptions.size ?? 'auto') + ', aspect ratio=' + (context.imageOptions.aspectRatio ?? 'auto') + '. Preserve these choices using supported native settings or the generation prompt; do not silently drop them.' : '',
    !context.prompt.trim() ? 'This is image-only generation: use the frozen reference image as the visual input. No user prompt was supplied; do not invent a user prompt or silently omit the reference.' : '',
  ].filter(Boolean).join('\n');
}
