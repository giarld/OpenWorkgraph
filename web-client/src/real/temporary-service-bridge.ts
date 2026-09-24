import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sniffResourceMime } from '../../../packages/protocol/src/resource-mime';
import { graphPath, type Request } from './contracts';
import type { TemporaryCanvasStore } from './temporary-store';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

export interface TemporaryServiceBinding {
  serviceId: string;
  projectId: string;
  sessionId: string;
  request: Request;
  /** Must check connection generation, selected graph and selected project. */
  isCurrent: () => boolean;
}
export const temporaryExecutionReason = 'The current Runtime can only execute Work Graphs in its database. A temporary execution contract that preserves browser Work Graph identity, resources, and run results is not available yet.';
const failure = (code: string, message: string) => Object.assign(Error(message), { code });
const digest = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
type Store = Pick<TemporaryCanvasStore, 'request' | 'readResource' | 'reserveServiceOperation' | 'finishServiceOperation'>;
type Upload = { uploadId: string; received: number; bytes: number; state: string };

/** Routes service capabilities without importing, renaming or navigating the graph.
 * The binding is immutable: create another bridge after a connection/scope change. */
export function createTemporaryServiceBridge(store: Store, graphId: string, binding?: TemporaryServiceBinding) {
  binding = binding ? Object.freeze({ ...binding }) : undefined;
  const local = graphPath('temporary', graphId);
  const remote = binding ? '/v1/projects/' + encodeURIComponent(binding.projectId) : '';
  const guard = () => {
    if (!binding) throw failure('SERVICE_UNAVAILABLE', translate("Connect a Runtime and select the project that owns the asset library."));
    if (!binding.isCurrent()) throw failure('REQUEST_CANCELLED', translate("The Work Graph, project, or Runtime connection for this request changed."));
  };
  const send: Request = async <T>(path: string, body?: unknown, method?: string) => {
    guard();
    const result = await binding!.request<T>(path, body, method);
    guard();
    return result;
  };
  // Coalesce retries in this instance; IndexedDB receipts also isolate other tabs.
  const pending = new Map<string, { signature: string; promise: Promise<unknown> }>();
  async function transfer(action: string, body: unknown) {
    guard();
    const input = body as Record<string, unknown>;
    if (!input || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey) throw failure('INVALID_REQUEST', translate("Resource operations require an idempotency key."));
    const save = action === 'save-to-library';
    const id = save ? input.resourceId : input.assetId;
    const version = input.expectedVersion;
    if (typeof id !== 'string' || !id || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || (save && (typeof input.name !== 'string' || !input.name.trim()))) throw failure('INVALID_REQUEST', translate("The resource identity, version, or name is invalid."));
    const key = action + ':' + input.idempotencyKey;
    // Store only a digest of session identity; never persist authentication tokens.
    const signature = digest(JSON.stringify([binding!.serviceId, binding!.projectId, binding!.sessionId, graphId, action, id, version, save ? input.name : null]));
    const running = pending.get(key);
    if (running) {
      if (running.signature !== signature) throw failure('IDEMPOTENCY_CONFLICT', translate("The parameters for this idempotency key changed."));
      return running.promise;
    }
    const promise = (async () => {
      const prior = await store.reserveServiceOperation(graphId, key, signature, guard);
      guard();
      if (prior !== undefined) return prior;
      if (!save) {
        const assetPath = remote + '/assets/' + encodeURIComponent(id);
        const asset = await send<{ name: string; deleted: boolean; current: { version: number; mime: string } }>(assetPath);
        if (asset.deleted || asset.current.version !== version) throw Object.assign(failure('REVISION_CONFLICT', translate("The asset version changed. Refresh and select it again.")), { status: 409 });
        const blob = await send<Blob>(assetPath + '/versions/' + version + '/content', undefined, 'BLOB');
        return store.finishServiceOperation(graphId, key, signature, undefined, guard, { name: asset.name, blob: new Blob([blob], { type: asset.current.mime }) });
      }
      const resource = await store.readResource(graphId, id, version);
      const bytes = new Uint8Array(await resource.blob.arrayBuffer());
      guard();
      const detected = sniffResourceMime(bytes);
      const declared = resource.blob.type;
      const mime = detected === 'text/plain' && ['text/plain', 'text/markdown', 'text/csv', 'image/svg+xml', 'application/json', 'application/xml', 'text/xml', 'text/yaml', 'text/x-yaml', 'application/yaml', 'application/x-yaml'].includes(declared) ? declared : detected;
      const base = remote + '/uploads';
      const job = digest(key + ':' + signature);
      const started = await send<Upload>(base, { name: input.name, mime, bytes: bytes.length, sha256: bytesToHex(sha256(bytes)), idempotencyKey: job + '-start' });
      const uploadPath = base + '/' + encodeURIComponent(started.uploadId);
      let status = await send<Upload>(uploadPath);
      if (status.bytes !== bytes.length || !Number.isSafeInteger(status.received) || status.received < 0 || status.received > bytes.length) throw failure('REVISION_CONFLICT', translate("The upload state does not match the original file."));
      if (status.state !== 'uploading' && status.state !== 'finished') throw failure('REVISION_CONFLICT', translate("The original upload is no longer valid. A replacement submission cannot be created automatically."));
      if (status.state === 'finished' && status.received !== bytes.length) throw failure('REVISION_CONFLICT', translate("The completed upload byte count does not match."));
      while (status.state === 'uploading' && status.received < bytes.length) {
        const offset = status.received;
        const chunk = bytes.subarray(offset, offset + 1024 * 1024);
        let binary = '';
        for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
        status = await send<Upload>(uploadPath + '/chunks', { offset, data: btoa(binary), idempotencyKey: job + '-chunk-' + offset });
        if (status.received !== offset + chunk.length || status.bytes !== bytes.length) throw failure('REVISION_CONFLICT', translate("The upload progress does not match the submitted chunk."));
      }
      // Replay this exact finish even when its previous response was lost.
      const result = await send(uploadPath + '/finish', { mode: 'new', name: input.name, idempotencyKey: job + '-finish' });
      return store.finishServiceOperation(graphId, key, signature, result, guard);
    })();
    pending.set(key, { signature, promise });
    try { return await promise; } finally { pending.delete(key); }
  }
  const request: Request = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    if (path === '/v1/models') throw failure('TEMPORARY_MODELS_UNAVAILABLE', translate("Temporary Work Graphs do not use the Runtime model catalog."));
    if (path === local + '/runs' || path === local + '/input-preview') {
      guard();
      throw failure('TEMPORARY_EXECUTION_UNSUPPORTED', translate(temporaryExecutionReason));
    }
    for (const action of ['copy-asset', 'save-to-library']) {
      if (path === local + '/resources/' + action && body !== undefined) return await transfer(action, body) as T;
    }
    const projectRoute = /^[/]v1[/]projects[/]temporary[/](assets|uploads)([/].*)?$/.exec(path);
    if (projectRoute) {
      // A library upload may never accidentally create a remote canvas resource.
      if (projectRoute[1] === 'uploads' && body && typeof body === 'object' && 'mode' in body && body.mode === 'canvas') throw failure('INVALID_REQUEST', translate("Work Graph uploads should use browser storage."));
      return send<T>(remote + '/' + projectRoute[1] + (projectRoute[2] ?? ''), body, method);
    }
    if (path !== local && !path.startsWith(local + '/')) throw failure('REQUEST_CANCELLED', translate("The request does not belong to the current temporary Work Graph."));
    return store.request<T>(path, body, method);
  };
  return { request, capabilities: { models: false, assets: Boolean(binding), execution: false, executionReason: translate(temporaryExecutionReason) } };
}
