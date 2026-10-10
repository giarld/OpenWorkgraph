import type { Json, VisualizeResourceReference } from '@openworkgraph/protocol';
import { checkedVisualizeJson, VisualizeValidationError } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

export interface GeneratedVisualizeAsset extends VisualizeResourceReference { mime: string }
/** Output keys are local to this verified manifest; no model-invented resource IDs. */
export function resolveGeneratedVisualizeAssets(value: unknown, outputs: Map<string, GeneratedVisualizeAsset>): unknown {
  let page: Json;
  try { page = checkedVisualizeJson(value, 4_194_304); }
  catch (error) {
    if (error instanceof VisualizeValidationError && error.code === 'PAYLOAD_TOO_LARGE') throw new ServiceError('PAYLOAD_TOO_LARGE', '页面包超过 4 MiB 或结构深度上限；图片、视频等资产请使用资源引用或项目相对路径。');
    throw error;
  }
  function asset(value: Json): Json {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && value.format === 'openworkgraph.asset-reference' && value.kind === 'output') {
      if (value.version !== 1 || Object.keys(value).length !== 4 || typeof value.outputKey !== 'string') throw new ServiceError('INVALID_REQUEST', '生成资产引用必须包含 format/version/kind/outputKey。');
      const selected = outputs.get(value.outputKey);
      if (!selected || !/^(image|video|audio)[/]/.test(selected.mime)) throw new ServiceError('INPUT_BLOCKED', '生成资产不在当前交付清单中：' + value.outputKey);
      return { format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId: selected.resourceId, resourceVersion: selected.resourceVersion };
    }
    return Array.isArray(value) ? value.map(asset) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, asset(child)]));
  }
  const result = asset(page);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const replacements = new Map<string, string>();
  if (Array.isArray(result.dependencies)) result.dependencies = result.dependencies.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'output') return value;
    if (Object.keys(value).length !== 4 || typeof value.outputKey !== 'string' || typeof value.id !== 'string' || !['image', 'video'].includes(String(value.media))) throw new ServiceError('INVALID_REQUEST', '生成资产依赖字段无效。');
    const selected = outputs.get(value.outputKey);
    if (!selected || !(selected.mime.startsWith(String(value.media) + '/') || value.media === 'video' && selected.mime.startsWith('audio/'))) throw new ServiceError('INPUT_BLOCKED', '生成资产不存在或媒体类型不匹配：' + value.outputKey);
    replacements.set('visualize-output:' + value.outputKey, 'visualize-resource:' + encodeURIComponent(selected.resourceId) + '@' + selected.resourceVersion);
    return { kind: 'resource', id: value.id, media: String(value.media), resourceId: selected.resourceId, resourceVersion: selected.resourceVersion };
  });
  if (typeof result.html === 'string') result.html = result.html.replace(/visualize-output:([a-zA-Z0-9_-]+)/g, marker => replacements.get(marker) ?? marker);
  return result;
}
