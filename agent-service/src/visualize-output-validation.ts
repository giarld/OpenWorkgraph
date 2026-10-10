import { VisualizeValidationError, type VisualizeFieldError } from '@openworkgraph/protocol';
import { hashBytes } from './blob-store.js';
import { ServiceError } from './errors.js';
import { MAX_MANIFEST, parsePublicationManifest, readPublicationOutput, validatePublicationOutputBytes } from './publication.js';
import type { GeneratedVisualizeAsset } from './visualize-generated-assets.js';
import { validateGeneratedVisualizePage } from './visualize-publication.js';

export type VisualizeOutputValidation =
  | { valid: true; path: string; bytes: number; sha256: string; checks: string[]; remainingChecks: string[] }
  | { valid: false; error: { code: string; message: string; fields: VisualizeFieldError[] } };

/** Read-only validation of actual Output files. Publication still owns resource
 * authorization, registration and installation; this is not a publication receipt. */
export async function validateVisualizeOutput(root: string, path: string, kind: 'execution' | 'visualize_generation'): Promise<VisualizeOutputValidation> {
  try {
    if (typeof path !== 'string' || !path || path.length > 512) throw new ServiceError('INVALID_REQUEST', 'Provide a page path relative to this Run Output directory.');
    const manifestBytes = await readPublicationOutput(root, 'manifest.json', MAX_MANIFEST);
    const manifest = parsePublicationManifest(JSON.parse(manifestBytes.toString('utf8')), kind === 'execution' ? 2 : 1, kind === 'visualize_generation');
    const output = manifest.outputs.find(item => item.path === path && item.role !== 'project-file' && item.mime === 'application/json' && (kind === 'visualize_generation' || item.nodeType === 'visualize'));
    if (!output) throw new ServiceError('INVALID_REQUEST', 'Declare this page in manifest.json as the visualize JSON output before validation.');
    const bytes = await readPublicationOutput(root, path, 4_194_304);
    const sha256 = hashBytes(bytes);
    if (bytes.length !== output.bytes || sha256 !== output.sha256) throw new ServiceError('INVALID_REQUEST', 'Page size/hash mismatch. Recompute manifest.json bytes and sha256 after every page edit, then validate again.');
    const generated = new Map<string, GeneratedVisualizeAsset>();
    for (const item of manifest.outputs) {
      if (item.role === 'project-file' || !/^(image|video|audio)[/]/.test(item.mime)) continue;
      const media = await readPublicationOutput(root, item.path, Math.min(item.bytes, 64 * 1024 * 1024));
      validatePublicationOutputBytes(item, media);
      // These identities exist only in this validation copy; no persistent IDs or
      // resource records are allocated before the real publication transaction.
      generated.set(item.outputKey, { resourceId: 'preflight-' + item.outputKey, resourceVersion: 1, mime: item.mime });
    }
    validateGeneratedVisualizePage(JSON.parse(bytes.toString('utf8')), generated);
    return { valid: true, path, bytes: bytes.length, sha256, checks: ['publication-manifest', 'page-size-and-sha256', 'generated-media-size-sha256-and-mime', 'page-protocol'], remainingChecks: ['Publication verifies existing resource access and project dependencies, then installs the page.', 'Browser interactions and downloads require separate testing.'] };
  } catch (error) {
    if (error instanceof VisualizeValidationError) return { valid: false, error: { code: error.code, message: error.message, fields: error.fields } };
    if (error instanceof ServiceError) {
      const details = error.details as { fields?: VisualizeFieldError[] } | undefined;
      return { valid: false, error: { code: error.code, message: error.message, fields: details?.fields ?? [] } };
    }
    if (error instanceof SyntaxError) return { valid: false, error: { code: 'INVALID_REQUEST', message: 'Page or manifest is not valid JSON. Write UTF-8 without BOM and validate again.', fields: [] } };
    return { valid: false, error: { code: 'OUTPUT_UNAVAILABLE', message: 'Page or manifest could not be read as a bounded regular file in this Run Output directory. Check that the files exist and validate again.', fields: [] } };
  }
}
