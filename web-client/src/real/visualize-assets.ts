import type { GraphScope, VisualizeInputSnapshot, VisualizePagePackage, Json } from '../../../packages/protocol/src/index';
import { WORKGRAPH_UPLOAD_MAX_BYTES } from '../../../packages/protocol/src/index';
import type { RangeBlob } from '../adapter/transport';
import { graphPath, messageOf, type Request } from './contracts';
import type { VisualizeAssetReference } from '../../../packages/protocol/src/visualize';
import { collectVisualizeAssetReferences, visualizeAssetUrl } from '../../../packages/protocol/src/visualize-assets';
import type { VisualizeStaticResource } from './visualize-html';

export interface VisualizeBinaryAsset { key: string; media: VisualizeStaticResource['media']; mime: string; bytes: ArrayBuffer }
/** Generic files are data, not executable page dependencies. */
export function visualizeAssetMedia(mime: string): VisualizeStaticResource['media'] {
  return mime.startsWith('image/') ? 'image' : /^(video|audio)[/]/.test(mime) ? 'video'
    : mime === 'text/css' ? 'style' : /^(text|application)[/](javascript|ecmascript)$/.test(mime) ? 'script' : 'binary';
}
export function visualizeBinaryResource(asset: VisualizeAssetReference, media: VisualizeStaticResource['media']): VisualizeStaticResource {
  const key = visualizeAssetUrl(asset);
  return { resourceId: asset.kind === 'resource' ? asset.resourceId : asset.relativePath, resourceVersion: asset.kind === 'resource' ? asset.resourceVersion : 1,
    ...(asset.kind === 'project-file' ? { relativePath: asset.relativePath } : {}), media, url: 'visualize-host-asset:' + encodeURIComponent(key) };
}
/** Binary bytes stay outside JSON/srcdoc. Only the bound opaque iframe can receive them. */
export function bindVisualizeAssetTransport(host: Window, frame: () => HTMLIFrameElement | null, identity: { sessionId: string; nodeId: string }, assets: VisualizeBinaryAsset[]): () => void {
  let delivered = false;
  const receive = (event: MessageEvent) => {
    const target = frame()?.contentWindow, request = event.data;
    if (delivered || !target || event.source !== target || event.origin !== 'null' || !request || request.channel !== 'openworkgraph.visualize.assets' || request.version !== 1 || request.type !== 'request' || request.sessionId !== identity.sessionId || request.nodeId !== identity.nodeId) return;
    delivered = true;
    const copies = assets.map(asset => ({ ...asset, bytes: asset.bytes }));
    target.postMessage({ channel: 'openworkgraph.visualize.assets', version: 1, type: 'response', sessionId: identity.sessionId, nodeId: identity.nodeId, assets: copies }, '*', copies.map(asset => asset.bytes));
  };
  host.addEventListener('message', receive);
  return () => host.removeEventListener('message', receive);
}

/** Publish before the bridge response so refreshed inputs already have usable URLs. */
export function updateVisualizePageAssets(frame: HTMLIFrameElement | null, identity: { sessionId: string; nodeId: string }, assets: VisualizeBinaryAsset[]): void {
  frame?.contentWindow?.postMessage({ channel: 'openworkgraph.visualize.assets', version: 1, type: 'update', sessionId: identity.sessionId, nodeId: identity.nodeId, assets }, '*', assets.map(asset => asset.bytes));
}

/** Resolve accepted descriptors in the host; never give the iframe Transport or credentials. */
export async function loadVisualizePageAssets({ request, scope, page, form, state = null, inputs, includePageAssets = true, alive }: { request: Request; scope: GraphScope; page: VisualizePagePackage; form: Json; state?: Json; inputs?: VisualizeInputSnapshot; includePageAssets?: boolean; alive: () => boolean }): Promise<{ resources: VisualizeStaticResource[]; binaryAssets: VisualizeBinaryAsset[]; errors: string[] }> {
  const errors: string[] = [];
  let totalBytes = 0;
  const resources: VisualizeStaticResource[] = [], binaryAssets: VisualizeBinaryAsset[] = [];
  const declared = new Map<string, { asset: VisualizeAssetReference; media: VisualizeStaticResource["media"]; bytes?: number; changeToken?: string; mime?: string }>();
  const add = (asset: VisualizeAssetReference, media: VisualizeStaticResource["media"], bytes?: number, changeToken?: string, mime?: string) => declared.set(visualizeAssetUrl(asset), { asset, media, bytes, changeToken, mime });
  for (const dependency of includePageAssets ? page.dependencies : []) {
    if (dependency.kind === "resource") add({ format: "openworkgraph.asset-reference", version: 1, kind: "resource", resourceId: dependency.resourceId, resourceVersion: dependency.resourceVersion }, dependency.media);
    if (dependency.kind === "project-file") add({ format: "openworkgraph.asset-reference", version: 1, kind: "project-file", relativePath: dependency.relativePath, mode: "live" }, dependency.media);
  }
  for (const input of inputs?.inputs ?? []) {
    for (const envelope of input.resources) {
      const resource = envelope.resource; if (!resource) continue;
      add({ format: "openworkgraph.asset-reference", version: 1, kind: "resource", resourceId: resource.resourceId, resourceVersion: resource.version }, visualizeAssetMedia(resource.mime), resource.bytes, undefined, resource.mime);
    }
    for (const file of input.projectFileData ?? []) {
      if (file.text === null) {
        const media = visualizeAssetMedia(file.mime);
        add(file.asset, media === 'image' || media === 'video' ? media : 'binary', file.bytes, file.changeToken, file.mime);
      }
    }
  }
  // Match the stored page and current snapshot closures without merging their
  // independent reference budgets. Input refreshes only fetch new input assets.
  const assetData: Json[] = [{ form, state }];
  if (includePageAssets) assetData.unshift({ schema: page.form.schema as unknown as Json, initialForm: page.initialForm, initialState: page.initialState });
  for (const asset of assetData.flatMap(collectVisualizeAssetReferences)) {
    if (declared.has(visualizeAssetUrl(asset))) continue;
    try {
      const metadata = asset.kind === 'resource'
        ? await request<{mime: string; bytes: number}>(graphPath(scope.projectId, scope.graphId) + '/resources/' + encodeURIComponent(asset.resourceId) + '/versions/' + asset.resourceVersion)
        : (await request<{mime: string; bytes: number; state: string}[]>('/v1/projects/' + encodeURIComponent(scope.projectId) + '/files/stat', {paths: [asset.relativePath]}))[0];
      const media = visualizeAssetMedia(metadata.mime ?? '');
      add(asset, asset.kind === 'project-file' && media !== 'image' && media !== 'video' ? 'binary' : media, metadata.bytes, undefined, metadata.mime);
    } catch (reason) { errors.push(messageOf(reason)); }
  }
  await Promise.all([...declared.values()].map(async ({ asset, media, bytes: expectedBytes, changeToken, mime }) => {
    try {
      let path: string, total = expectedBytes;
      if (asset.kind === "resource") {
        path = graphPath(scope.projectId, scope.graphId) + "/resources/" + encodeURIComponent(asset.resourceId) + "/versions/" + asset.resourceVersion + "/content";
        if (total === undefined) {
          const resource = await request<{ bytes: number }>(path.replace(/[/]content$/, "")); total = resource.bytes;
        }
      } else {
        const prefix = "/v1/projects/" + encodeURIComponent(scope.projectId) + "/files";
        const [current] = await request<{ state: string; bytes: number; changeToken: string; mime?: string }[]>(prefix + "/stat", { paths: [asset.relativePath] });
        if (current.state !== "available" || changeToken && current.changeToken !== changeToken) throw Error("项目资产已变化，请刷新输入。");
        total = current.bytes; changeToken = current.changeToken; mime ??= current.mime;
        path = prefix + "/content?" + new URLSearchParams({ path: asset.relativePath, changeToken }).toString();
      }
      if (!Number.isSafeInteger(total) || total! < 0 || total! > WORKGRAPH_UPLOAD_MAX_BYTES) throw Error("资产超过媒体加载上限。");
      totalBytes += total!;
      if (totalBytes > WORKGRAPH_UPLOAD_MAX_BYTES) throw Error("页面媒体合计超过 300 MB 加载上限。");
      const resource = visualizeBinaryResource(asset, media);
      let blob: Blob;
      // Fixed resources are verified as a whole by the Workspace. A Range request
      // would repeat that full-file read and hash for every chunk.
      if (asset.kind === "resource") blob = await request<Blob>(path, undefined, "BLOB");
      else {
        const chunks: Blob[] = [];
        for (let start = 0; start < total!; start += 4 * 1024 * 1024) {
          if (!alive()) return;
          const end = Math.min(total! - 1, start + 4 * 1024 * 1024 - 1);
          const range = await request<RangeBlob>(path, undefined, "RANGE", { range: { start, end } });
          if (range.total !== total || range.start !== start || range.end !== end) throw Error("资产在加载期间变化。");
          chunks.push(range.blob);
        }
        blob = new Blob(chunks, { type: chunks[0]?.type || mime || 'application/octet-stream' });
      }
      if (blob.size !== total) throw Error("资产大小不一致。");
      binaryAssets.push({ key: visualizeAssetUrl(asset), media, mime: blob.type || mime || 'application/octet-stream', bytes: await blob.arrayBuffer() });
      resources.push(resource);
    } catch (reason) { errors.push(messageOf(reason)); }
  }));
  return { resources, binaryAssets, errors };
}
