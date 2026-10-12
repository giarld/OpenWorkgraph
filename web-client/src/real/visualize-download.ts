import type { BundleResource, GraphScope, GraphSnapshot, Json, VisualizeStoredNode } from '../../../packages/protocol/src/index';
import { bytesBase64 } from '../../../packages/protocol/src/graph-binary';
import { collectVisualizeAssetReferences } from '../../../packages/protocol/src/visualize-assets';
import { buildVisualizeToolTemplate, sha256VisualizeLibraryBytes, visualizeAssetFilename, VISUALIZE_ASSET_MIME, VISUALIZE_LIBRARY_MAX_DECODED_BYTES, VISUALIZE_LIBRARY_MAX_RESOURCES } from '../../../packages/protocol/src/visualize-library';
import { translate } from '../i18n/translate';
import { graphPath, type Request } from './contracts';
import { randomId } from '../adapter/random';
import type { RangeBlob } from '../adapter/transport';

export function visualizeDownloadFilename(title: string): string {
  const name = (title.trim() || translate('Interactive page')).replace(/[\/\\\u0000-\u001f\u007f]/g, '_').slice(0, 220);
  return visualizeAssetFilename(name);
}

/** Export a portable tool template without creating or changing a library asset. */
export async function prepareVisualizeDownload(request: Request, scope: GraphScope, nodeId: string): Promise<{ blob: Blob; name: string }> {
  const root = graphPath(scope.projectId, scope.graphId);
  const [graph, stored] = await Promise.all([
    request<GraphSnapshot>(root), request<VisualizeStoredNode>(root + '/visualize/' + encodeURIComponent(nodeId)),
  ]);
  const node = graph.nodes.find(item => item.id === nodeId);
  const { content, page } = stored;
  const changed = () => { throw Error(translate('The visualization changed while preparing the download. Try again.')); };
  if (!node || node.type !== 'visualize' || !page || !content.page || !content.form || !content.state) throw Error(translate('Generate an interactive page before downloading it.'));
  if (node.contentVersion !== stored.contentVersion || graph.executionRevision !== stored.executionRevision || graph.layoutRevision !== stored.layoutRevision) changed();
  const fixed = new Map<string, { resourceId: string; resourceVersion: number }>();
  const add = (ref: { resourceId: string; resourceVersion: number }) => fixed.set(JSON.stringify([ref.resourceId, ref.resourceVersion]), ref);
  add(content.page.resource);
  const paths = new Set<string>();
  for (const dependency of page.dependencies) {
    if (dependency.kind === 'resource') add(dependency);
    else if (dependency.kind === 'project-file') paths.add(dependency.relativePath);
  }
  for (const data of [page.form.schema, page.initialForm, page.initialState]) {
    for (const ref of collectVisualizeAssetReferences(data as Json)) {
      if (ref.kind === 'resource') add(ref); else paths.add(ref.relativePath);
    }
  }
  if (fixed.size + paths.size > VISUALIZE_LIBRARY_MAX_RESOURCES) throw Error(translate('Interactive content exceeds the size limit.'));
  let total = 0;
  const budget = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || (total += bytes) > VISUALIZE_LIBRARY_MAX_DECODED_BYTES) throw Error(translate('Interactive content exceeds the size limit.'));
  };
  const resource = async (id: string, version: number, name: string, mime: string, blob: Blob): Promise<BundleResource> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { resourceId: id, version, name, mime, bytes: bytes.length, sha256: sha256VisualizeLibraryBytes(bytes), base64: bytesBase64(bytes) };
  };
  const resources: BundleResource[] = [];
  const projectFiles: Record<string, BundleResource> = Object.create(null);
  const tokens = new Map<string, string>();
  for (const ref of fixed.values()) {
    const path = root + '/resources/' + encodeURIComponent(ref.resourceId) + '/versions/' + ref.resourceVersion;
    const metadata = await request<{ name?: string; mime: string; bytes: number; sha256?: string }>(path);
    budget(metadata.bytes);
    const blob = await request<Blob>(path + '/content', undefined, 'BLOB');
    const value = await resource(ref.resourceId, ref.resourceVersion, metadata.name || ref.resourceId, metadata.mime, blob);
    if (value.bytes !== metadata.bytes || metadata.sha256 && value.sha256 !== metadata.sha256) changed();
    resources.push(value);
  }
  const files = '/v1/projects/' + encodeURIComponent(scope.projectId) + '/files';
  for (const path of paths) {
    const [stat] = await request<Array<{ state: string; bytes: number; changeToken: string; name: string; mime?: string }>>(files + '/stat', { paths: [path] });
    if (!stat || stat.state !== 'available' || !stat.changeToken) throw Error(translate('Unable to view this file.'));
    budget(stat.bytes);
    const chunks: Blob[] = [];
    const contentPath = files + '/content?' + new URLSearchParams({ path, changeToken: stat.changeToken });
    for (let start = 0; start < stat.bytes; start += 4 * 1024 * 1024) {
      const end = Math.min(stat.bytes - 1, start + 4 * 1024 * 1024 - 1);
      const range = await request<RangeBlob>(contentPath, undefined, 'RANGE', { range: { start, end } });
      if (range.total !== stat.bytes || range.start !== start || range.end !== end || range.blob.size !== end - start + 1) changed();
      chunks.push(range.blob);
    }
    const blob = new Blob(chunks, { type: stat.mime || chunks[0]?.type || 'application/octet-stream' });
    if (blob.size !== stat.bytes) changed();
    projectFiles[path] = await resource('project-download-' + randomId(), 1, stat.name, stat.mime || blob.type, blob);
    tokens.set(path, stat.changeToken);
  }
  const pkg = buildVisualizeToolTemplate({ node, page, resources, projectFiles });
  for (const [path, token] of tokens) {
    const [stat] = await request<Array<{ changeToken: string }>>(files + '/stat', { paths: [path] });
    if (stat?.changeToken !== token) changed();
  }
  const latest = await request<VisualizeStoredNode>(root + '/visualize/' + encodeURIComponent(nodeId));
  if (latest.contentVersion !== stored.contentVersion || latest.executionRevision !== stored.executionRevision || latest.layoutRevision !== stored.layoutRevision) changed();
  return { blob: new Blob([JSON.stringify(pkg)], { type: VISUALIZE_ASSET_MIME }), name: visualizeDownloadFilename(pkg.title) };
}

export function downloadVisualizeBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function visualizeStandaloneUrl(scope: GraphScope, nodeId: string, temporary: boolean, theme?: string): string {
  const url = new URL(import.meta.env.BASE_URL + 'workgraphs.html', location.origin);
  url.search = new URLSearchParams({ view: 'visualize', ...scope, nodeId, temporary: String(temporary), ...(theme ? { theme } : {}) }).toString();
  return url.href;
}

export function openVisualizeStandalone(url: string): void {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const features = mobile ? 'noopener,noreferrer' : 'popup,width=1100,height=800,resizable=yes,scrollbars=yes,noopener,noreferrer';
  window.open(url, '_blank', features);
}
