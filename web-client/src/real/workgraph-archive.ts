import { strToU8, unzip, zip } from 'fflate';
import type { BundleResource, GraphBundle } from '../../../packages/protocol/src/index';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

export const WORKGRAPH_ARCHIVE_MIME = 'application/vnd.openworkgraph.graph+zip';
export const WORKGRAPH_ARCHIVE_MAX_BYTES = 96 * 1024 * 1024;
const WORKGRAPH_MANIFEST = 'workgraph.json';
const WORKGRAPH_ARCHIVE_MAX_ENTRIES = 258;

type ArchiveResource = Omit<BundleResource, 'base64'> & { path: string };
type WorkGraphArchiveManifest = Omit<GraphBundle, 'format' | 'version' | 'resources'> & {
  format: 'openworkgraph.graph-archive';
  version: 1;
  resources: ArchiveResource[];
};

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function safeAssetName(name: string, index: number): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 160) || 'resource';
  return `assets/${String(index + 1).padStart(4, '0')}-${cleaned}`;
}

function isSafeEntry(name: string): boolean {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..')) return false;
  return name === WORKGRAPH_MANIFEST || name === 'assets/' || name.startsWith('assets/');
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]!) && [0x04, 0x06, 0x08].includes(bytes[3]!);
}

export function workGraphArchiveFilename(title: string): string {
  const safe = title.normalize('NFC').replace(/[\\/?%*:|"<>\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim() || translate("Work Graph");
  return safe + '.workgraph.zip';
}

function zipFiles(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)));
}

export async function createWorkGraphArchive(bundle: GraphBundle): Promise<Blob> {
  const files: Record<string, Uint8Array> = Object.create(null);
  const paths = new Set<string>();
  const resources: ArchiveResource[] = bundle.resources.map((resource, index) => {
    let path = safeAssetName(resource.name, index);
    while (paths.has(path)) path = path.replace(/(?=[^/]+$)/, `${index + 1}-`);
    paths.add(path);
    const bytes = decodeBase64(resource.base64);
    if (bytes.length !== resource.bytes) throw new Error(translate('Resource “{name}” failed size verification and cannot be exported.', { name: resource.name }));
    files[path] = bytes;
    const { base64: _base64, ...metadata } = resource;
    return { ...metadata, path };
  });
  const manifest: WorkGraphArchiveManifest = {
    format: 'openworkgraph.graph-archive',
    version: 1,
    graph: bundle.graph,
    resources,
    pluginRequirements: bundle.pluginRequirements,
    ...(bundle.copiedProvenance ? { copiedProvenance: bundle.copiedProvenance } : {}),
  };
  files[WORKGRAPH_MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
  const archive = await zipFiles(files);
  const body = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
  return new Blob([body], { type: WORKGRAPH_ARCHIVE_MIME });
}

export async function readWorkGraphFile(file: Blob): Promise<GraphBundle> {
  if (file.size > WORKGRAPH_ARCHIVE_MAX_BYTES) throw new Error(translate("The Work Graph file cannot exceed 96 MiB."));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) throw new Error(translate("The Work Graph file must be a ZIP archive."));

  let entryCount = 0;
  let inflatedBytes = 0;
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    try {
      unzip(bytes, {
        filter(entry) {
          entryCount++;
          if (entryCount > WORKGRAPH_ARCHIVE_MAX_ENTRIES || !isSafeEntry(entry.name)) throw new Error(translate("The Work Graph ZIP contains an invalid file."));
          inflatedBytes += entry.originalSize;
          if (inflatedBytes > WORKGRAPH_ARCHIVE_MAX_BYTES) throw new Error(translate("The extracted Work Graph ZIP exceeds 96 MiB."));
          return entry.name !== 'assets/';
        },
      }, (error, data) => error ? reject(error) : resolve(data));
    } catch (error) { reject(error); }
  });
  const manifestBytes = files[WORKGRAPH_MANIFEST];
  if (!manifestBytes) throw new Error(translate("The Work Graph ZIP does not contain a valid workgraph.json."));
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as WorkGraphArchiveManifest;
  if (!manifest || manifest.format !== 'openworkgraph.graph-archive' || manifest.version !== 1 || !Array.isArray(manifest.resources)) throw new Error(translate("The Work Graph ZIP format is invalid."));
  const usedPaths = new Set<string>();
  const resources: BundleResource[] = manifest.resources.map(resource => {
    if (!resource || typeof resource.path !== 'string' || !resource.path.startsWith('assets/') || !isSafeEntry(resource.path) || usedPaths.has(resource.path)) throw new Error(translate("A resource path in the Work Graph ZIP is invalid or duplicated."));
    usedPaths.add(resource.path);
    const content = files[resource.path];
    if (!content || content.length !== resource.bytes) throw new Error(translate('Work Graph resource “{name}” is missing or has the wrong size.', { name: resource.name }));
    const { path: _path, ...metadata } = resource;
    return { ...metadata, base64: encodeBase64(content) };
  });
  const { format: _format, version: _version, resources: _resources, ...portable } = manifest;
  return { format: 'openworkgraph.graph', version: 1, ...portable, resources };
}
