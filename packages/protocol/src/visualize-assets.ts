import type { Json } from './index.js';
import type { VisualizeAssetReference } from './visualize.js';
import { checkedVisualizeJson, VisualizeValidationError } from './visualize-validation.js';

export const VISUALIZE_ASSET_FORMAT = 'openworkgraph.asset-reference' as const;
function invalid(): never { throw new VisualizeValidationError('INVALID_REQUEST', 'Invalid asset reference'); }
export function isVisualizeProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/^(?:[/\\]|[A-Za-z]:)/.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
/** Only explicitly tagged objects are assets. Ordinary IDs/paths stay business data. */
export function validateVisualizeAssetReference(value: unknown): VisualizeAssetReference {
  const asset = checkedVisualizeJson(value, 8192, 2);
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || asset.format !== VISUALIZE_ASSET_FORMAT || asset.version !== 1) invalid();
  const fields = asset.kind === 'resource' ? ['format', 'version', 'kind', 'resourceId', 'resourceVersion'] : ['format', 'version', 'kind', 'relativePath', 'mode'];
  if (Object.keys(asset).length !== fields.length || Object.keys(asset).some(key => !fields.includes(key))) invalid();
  if (asset.kind === 'resource') {
    if (typeof asset.resourceId !== 'string' || !asset.resourceId.trim() || asset.resourceId.length > 256 || !Number.isSafeInteger(asset.resourceVersion) || Number(asset.resourceVersion) < 1) invalid();
  } else if (asset.kind !== 'project-file' || asset.mode !== 'live' || !isVisualizeProjectPath(asset.relativePath)) invalid();
  return asset as unknown as VisualizeAssetReference;
}
export function collectVisualizeAssetReferences(value: Json): VisualizeAssetReference[] {
  const result = new Map<string, VisualizeAssetReference>();
  function visit(item: Json): void {
    if (!item || typeof item !== 'object') return;
    if (!Array.isArray(item) && item.format === VISUALIZE_ASSET_FORMAT) {
      const asset = validateVisualizeAssetReference(item);
      result.set(JSON.stringify(asset.kind === 'resource' ? [asset.kind, asset.resourceId, asset.resourceVersion] : [asset.kind, asset.relativePath]), asset);
      if (result.size > 64) throw new VisualizeValidationError('PAYLOAD_TOO_LARGE', 'Too many asset references');
      return;
    }
    for (const child of Object.values(item)) visit(child);
  }
  visit(checkedVisualizeJson(value));
  return [...result.values()];
}
export function visualizeAssetUrl(asset: VisualizeAssetReference): string {
  return asset.kind === 'resource' ? 'visualize-resource:' + encodeURIComponent(asset.resourceId) + '@' + asset.resourceVersion
    : 'visualize-project-file:' + encodeURIComponent(asset.relativePath);
}
