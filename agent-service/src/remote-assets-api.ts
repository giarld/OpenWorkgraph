import type { IncomingMessage } from 'node:http';
import { createReadStream } from 'node:fs';
import sharp from 'sharp';
import type { RemoteTransferRequest } from '@openworkgraph/protocol';
import type { ApiResult } from './api.js';
import { RemoteAssets } from './remote-assets.js';
import { Auth } from './auth.js';
import { readJson } from './http.js';
import { ServiceError } from './errors.js';
import { remoteId } from './remote-assets-security.js';
import { videoThumbnail } from './video-thumbnail.js';
import { sniffMime } from './blob-store.js';
import { open } from 'node:fs/promises';

function fields(body: Record<string, unknown>, required: string[], optional: string[] = []): void { if (required.some(k => !Object.hasOwn(body, k)) || Object.keys(body).some(k => !required.includes(k) && !optional.includes(k))) throw new ServiceError('INVALID_REQUEST', 'Missing or unknown data source fields.'); }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ServiceError('INVALID_REQUEST', 'Invalid revision.'); return Number(value); }
export class RemoteAssetsApi {
  constructor(readonly assets: RemoteAssets, readonly auth: Auth) {}
  async handle(request: IncomingMessage, path: string, token: string, origin: string): Promise<ApiResult> {
    if (!path.startsWith('/v1/data-sources') && !path.startsWith('/v1/remote-transfers')) return { handled: false };
    const match = /^\/v1\/(data-sources|remote-transfers)(?:\/([a-zA-Z0-9_-]+))?(?:\/(test|list|remove|trust|retry|cancel|download|thumbnail|delivery|content|ack|sync))?$/.exec(path);
    if (!match) throw new ServiceError('NOT_FOUND', 'Remote asset endpoint not found.');
    this.auth.assertActive(token, origin);
    const [, section, id, action] = match;
    const body = request.method === 'POST' ? await readJson(request, 96 * 1024) : {};
    const read = <T>(work: () => T) => this.auth.withSession(token, origin, work);
    const reply = (value: unknown): ApiResult => ({ handled: true, body: value });
    if (section === 'data-sources') {
      if (request.method === 'GET' && !id) return reply(read(() => this.assets.sources()));
      if (request.method === 'POST' && !action) {
        fields(body, ['config'], id ? ['expectedRevision', 'credentials'] : ['credentials']); if (id) integer(body.expectedRevision);
        return reply(read(() => this.assets.save({ ...(id ? { id, expectedRevision: integer(body.expectedRevision) } : {}), config: body.config, ...(body.credentials === undefined ? {} : { credentials: body.credentials }) })));
      }
      if (request.method === 'POST' && id && action === 'remove') { fields(body, ['expectedRevision', 'confirmed']); if (body.confirmed !== true) throw new ServiceError('INVALID_REQUEST', 'Confirm removal of this data source and its saved credentials.'); return reply(read(() => { this.assets.remove(id, integer(body.expectedRevision)); return { removed: true }; })); }
      if (request.method === 'POST' && id && action === 'trust') { fields(body, ['expectedRevision', 'challengeId']); if (typeof body.challengeId !== 'string') throw new ServiceError('INVALID_REQUEST', 'Invalid host challenge.'); return reply(read(() => { this.assets.trust.confirm(id, integer(body.expectedRevision), remoteId(String(body.challengeId))); return { confirmed: true }; })); }
      if (request.method === 'POST' && id && action === 'test') { fields(body, ['expectedRevision']); const result = await this.assets.test(id, integer(body.expectedRevision)); return reply(read(() => result)); }
      if (request.method === 'POST' && id && action === 'list') { fields(body, ['locationRevision', 'path']); if (typeof body.path !== 'string') throw new ServiceError('INVALID_REQUEST', 'Invalid directory.'); const result = await this.assets.list(id, integer(body.locationRevision), body.path); return reply(read(() => result)); }
      if ((request.method === 'POST' || request.method === 'GET') && id && (action === 'download' || action === 'thumbnail')) {
        if (request.method === 'GET') { const query = new URL(request.url!, 'http://localhost').searchParams; if ([...query.keys()].some(k => !['path','locationRevision'].includes(k)) || query.getAll('path').length !== 1 || query.getAll('locationRevision').length !== 1) throw new ServiceError('INVALID_REQUEST', 'Invalid remote file query.'); body.path = query.get('path'); body.locationRevision = Number(query.get('locationRevision')); }
        fields(body, ['locationRevision', 'path']); if (typeof body.path !== 'string') throw new ServiceError('INVALID_REQUEST', 'Invalid file path.');
        const abort = new AbortController(); request.once('aborted', () => abort.abort());
        const result = await this.assets.download(id, integer(body.locationRevision), body.path, AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60_000)]), action === 'thumbnail' ? 32 * 1024 * 1024 : undefined);
        try {
          this.auth.assertActive(token, origin);
          if (action === 'thumbnail') {
            const file = await open(result.path, 'r'), prefix = Buffer.alloc(Math.min(result.bytes, 65536)); try { await file.read(prefix, 0, prefix.length, 0); } finally { await file.close(); }
            const mime = sniffMime(prefix); let binary: Buffer;
            if (mime.startsWith('image/')) binary = await sharp(result.path, { limitInputPixels: 40_000_000 }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
            else if (mime.startsWith('video/')) binary = await videoThumbnail(result.path, 320);
            else throw new ServiceError('UNSUPPORTED_MEDIA_TYPE', 'Thumbnail unavailable.');
            await result.dispose(); return read(() => ({ handled: true, binary, headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' } }));
          }
          return { handled: true, binaryStream: createReadStream(result.path), dispose: result.dispose, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(result.bytes), 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(result.name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } };
        } catch (e) { await result.dispose(); throw e; }
      }
    } else {
      if (id === 'temporary-targets' && request.method === 'POST') {
        if (action === 'sync') { fields(body, ['browserId','graphs']); if (typeof body.browserId !== 'string' || !Array.isArray(body.graphs)) throw new ServiceError('INVALID_REQUEST','Invalid temporary targets.'); read(() => this.assets.syncTemporaryTargets(body.browserId as string, body.graphs as {graphId:string;writable:boolean}[])); await this.assets.resources.drainFileDeletions(); }
        else if (!action) { fields(body, ['browserId','graphId','projectId'], ['revision']); if (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || Number(body.revision)<0)) throw new ServiceError('INVALID_REQUEST','Invalid temporary target revision.'); if (![body.browserId,body.graphId,body.projectId].every(v => typeof v === 'string')) throw new ServiceError('INVALID_REQUEST','Invalid temporary target.'); read(() => this.assets.registerTemporaryTarget(body.browserId as string,body.graphId as string,body.projectId as string,body.revision as number | undefined)); }
        else throw new ServiceError('NOT_FOUND','Temporary target endpoint not found.');
        return reply({updated:true});
      }
      if (id && action === 'ack' && request.method === 'POST') { fields(body,['browserId']); if(typeof body.browserId !== 'string') throw new ServiceError('INVALID_REQUEST','Invalid browser identity.'); read(() => this.assets.acknowledgeDelivery(id,body.browserId as string)); await this.assets.resources.drainFileDeletions(); return reply({acknowledged:true}); }
      if (request.method === 'GET' && !id) return reply(read(() => this.assets.transfers()));
      if (request.method === 'POST' && !id) { fields(body, ['idempotencyKey', 'sourceId', 'locationRevision', 'path', 'target']); integer(body.locationRevision); return reply(read(() => this.assets.accept(body as unknown as RemoteTransferRequest))); }
      if (id && request.method === 'GET' && !action) return reply(read(() => this.assets.transfer(id)));
      if (id && request.method === 'POST' && action === 'cancel') { fields(body, []); return reply(read(() => this.assets.cancel(id))); }
      if (id && request.method === 'POST' && action === 'retry') { fields(body, ['expectedAttempt']); return reply(read(() => this.assets.retry(id, integer(body.expectedAttempt)))); }
      if (id && request.method === 'GET' && (action === 'delivery' || action === 'content')) {
        const delivery = read(() => this.assets.db.prepare('SELECT d.*,f.path,b.bytes FROM remote_temporary_deliveries d JOIN resource_blob_files f USING(sha256) JOIN blobs b USING(sha256) WHERE d.id=?').get(id));
        if (!delivery) throw new ServiceError('NOT_FOUND', 'Temporary Work Graph delivery is unavailable.');
        if (action === 'delivery') return reply({ node: JSON.parse(String(delivery.node)), mime: delivery.mime, name: delivery.name, bytes: Number(delivery.bytes), sha256: delivery.sha256 });
        return { handled: true, binaryStream: createReadStream(String(delivery.path)), headers: { 'Content-Type': String(delivery.mime), 'Content-Length': String(delivery.bytes), 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } };
      }
    }
    throw new ServiceError('NOT_FOUND', 'Remote asset endpoint not found.');
  }
}
