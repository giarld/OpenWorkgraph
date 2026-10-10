import { limitNodeTitle, limitNodeContentTitle, VISUALIZE_DEFAULT_SIZE } from '@openworkgraph/protocol';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import type { GraphScope, Json, Run } from '@openworkgraph/protocol';
import { hashBytes, mimeMatchesBytes, sniffMime, supportsText, validMime } from './blob-store.js';
import type { PreparedBlob } from './blob-store.js';
import { runDirectories, type DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { Graphs } from './graphs.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { Resources, type CanvasResource } from './resources.js';
import { Runs, type RunToken } from './runs.js';
import { ProjectFiles, classifyProjectFile } from './project-files.js';
import { DEFAULT_EXECUTION_TITLES, promptRunTitle } from './run-title.js';
import { hasVisualizeFeature } from './visualize-features.js';
import { VisualizePublication, type PreparedVisualizePublication } from './visualize-publication.js';
import { commitTransferResource } from './visualize-transfer.js';
import { collectVisualizeAssetReferences } from '@openworkgraph/protocol';

type OutputRole = 'delivery-document' | 'project-file' | 'workgraph-node';
type OutputNodeType = 'text' | 'document' | 'image' | 'file' | 'visualize';
interface Output { outputKey: string; path: string; mime: string; bytes: number; sha256: string; role?: OutputRole; nodeType?: OutputNodeType; title?: string }
interface Manifest { version?: 2; executionTitle?: string; outputs: Output[] }
export interface CandidateDecision extends GraphScope { runId: string; expectedContentVersion: number; decision: 'accept' | 'discard' }
function invalid(message: string): never { throw new ServiceError('INVALID_REQUEST', message); }
function conflict(message: string): never { throw new ServiceError('REVISION_CONFLICT', message); }
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
export const MAX_MANIFEST = 64 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const imageMime = (mime: string): boolean => IMAGE_MIMES.has(mime);
// Binary project outputs remain live file references, not in-memory resources.
const streamedProjectFile = (role: OutputRole | undefined, mime: string): boolean => role === 'project-file' && !supportsText(mime) && !imageMime(mime);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function generatedTextTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
  const heading = firstLine.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
  const title = (heading?.[1] ?? firstLine).trim();
  return limitNodeTitle(title);
}
function executionTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 1024 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid('executionTitle must be a nonempty single line of at most 1024 input characters');
  return limitNodeTitle(value);
}
function generatedTextContent(current: Json, text: string, output?: Json, title = generatedTextTitle(text)): Json {
  if (!object(current)) return invalid('Text generation target requires editable text content');
  if (!title.trim() || title.length > 1024) invalid('Generated node title must be 1..1024 characters');
  const next: Record<string, unknown> = { ...current, title: limitNodeTitle(title), text };
  // Repair nodes written by the old publication path, which embedded output-file
  // metadata into an ordinary text node and made the UI treat it as a resource.
  for (const key of ['resourceId', 'resourceVersion', 'mime', 'outputKey', 'runId', 'outputs']) delete next[key];
  delete next.generatedOutput;
  if (output !== undefined) next.generatedOutput = output;
  return next as Json;
}

function generatedImageContent(current: Json, output: Json): Json {
  if (!object(current) || !object(output)) invalid('Image generation target requires editable image content');
  // The new resource replaces the old media, not the node's generation inputs.
  return { ...current, ...output } as Json;
}

export function parsePublicationManifest(value: unknown, version: 1 | 2, visualizeGeneration = false): Manifest {
  if (!object(value) || !Array.isArray(value.outputs) || !value.outputs.length || value.outputs.length > 33) return invalid('Expected 1..33 explicit outputs');
  if (version === 2 ? value.version !== 2 : value.version !== undefined) invalid(version === 2 ? 'Execution publication requires manifest version 2' : 'Legacy publication does not accept manifest version 2');
  if (version === 1 && value.executionTitle !== undefined) invalid('Only execution publication accepts executionTitle');
  const taskTitle = executionTitle(value.executionTitle);
  const keys = new Set<string>(), paths = new Set<string>(); let total = 0, markdown = 0, deliveries = 0;
  const outputs = value.outputs.map((item: unknown): Output => {
    if (!object(item) || typeof item.outputKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item.outputKey) || keys.has(item.outputKey)) return invalid('Invalid or duplicate outputKey');
    const role = version === 2 && ['delivery-document','project-file','workgraph-node'].includes(String(item.role)) ? item.role as OutputRole : version === 2 ? invalid('Manifest version 2 requires an explicit output role') : undefined;
    if (typeof item.path !== 'string' || !item.path || item.path.length > 512 || isAbsolute(item.path) || item.path.includes(String.fromCharCode(92)) || [...item.path].some(char => char.charCodeAt(0) < 32) || item.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has((role ?? 'legacy') + ':' + item.path)) return invalid('Invalid or duplicate output path');
    if (typeof item.mime !== 'string' || !validMime(item.mime)) return invalid('Invalid output MIME');
    const mime = item.mime.toLowerCase();
    if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < (role === 'project-file' ? 0 : 1)) return invalid('Invalid output byte count: ' + item.outputKey);
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return invalid('Invalid output SHA-256: ' + item.outputKey);
    const streaming = streamedProjectFile(role, mime);
    if (!streaming && Number(item.bytes) > MAX_TOTAL) invalid('In-memory output exceeds 64 MiB: ' + item.outputKey);
    if (!streaming && !supportsText(mime) && !imageMime(mime) && Number(item.bytes) > 50 * 1024 * 1024) return invalid('File output exceeds 50 MiB');
    if (mime === 'text/markdown' && role !== 'project-file') { markdown++; if (Number(item.bytes) > MAX_TEXT || !item.path.toLowerCase().endsWith('.md')) invalid('Markdown output must be a bounded .md file'); }
    if (role === 'delivery-document') { deliveries++; if (mime !== 'text/markdown') invalid('delivery-document must be Markdown'); }
    let nodeType: OutputNodeType | undefined, title: string | undefined;
    if (role === 'workgraph-node') {
      if (!['text','document','image','file','visualize'].includes(String(item.nodeType))) invalid('workgraph-node requires a supported nodeType');
      nodeType = item.nodeType as OutputNodeType;
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1024) invalid('workgraph-node requires a title of 1..1024 characters');
      title = limitNodeTitle(item.title);
      if ((nodeType === 'text' || nodeType === 'document') && (!supportsText(mime) || Number(item.bytes) > MAX_TEXT)) invalid(nodeType + ' workgraph-node requires bounded text content');
      if (nodeType === 'image' && !imageMime(mime) && mime !== 'image/svg+xml') invalid('image workgraph-node requires an image MIME');
      if (nodeType === 'visualize' && (mime !== 'application/json' || Number(item.bytes) > 4_194_304)) invalid('visualize workgraph-node requires a bounded application/json page package');
    } else if (item.nodeType !== undefined || item.title !== undefined) invalid('Only workgraph-node accepts nodeType and title');
    keys.add(item.outputKey); paths.add((role ?? 'legacy') + ':' + item.path); if (!streaming) total += Number(item.bytes);
    return { outputKey:item.outputKey, path:item.path, mime, bytes:Number(item.bytes), sha256:item.sha256, ...(role ? { role } : {}), ...(nodeType && title ? { nodeType, title } : {}) };
  });
  if (visualizeGeneration) {
    if (version !== 1 || outputs.filter(output => output.mime === 'application/json').length !== 1 || outputs.some(output => output.mime !== 'application/json' && !/^(image|video|audio)[/]/.test(output.mime) && !(output.mime === 'text/markdown' && output.path === 'description.md')) || markdown > 1 || total > MAX_TOTAL) invalid('Visualize generation requires one JSON page package, optional description.md and separate media assets');
  } else if ((version === 1 && markdown !== 1) || (version === 2 && deliveries !== 1) || total > MAX_TOTAL) return invalid(version === 2 ? 'Exactly one delivery-document and at most 64 MiB required' : 'Exactly one Markdown output and at most 64 MiB required');
  return { ...(version === 2 ? { version:2 as const } : {}), ...(taskTitle ? { executionTitle:taskTitle } : {}), outputs };
}

/** Reject links in every component, then read only a bounded regular-file handle.
 * Rechecking identity after reading also rejects replacement during preflight. */
export async function readPublicationOutput(root: string, path: string, max: number): Promise<Buffer> {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) invalid('Output escaped run directory');
  let current = root;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) invalid('Output symlinks are forbidden');
  }
  if (await realpath(target) !== target) invalid('Output must have a canonical path');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > max) invalid('Output must be a bounded private regular file');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { const chunk = await file.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
    const after = await file.stat(), entry = await lstat(target);
    if (offset !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || entry.ino !== before.ino || entry.dev !== before.dev || await realpath(target) !== target) invalid('Output changed during preflight');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

export function validatePublicationOutputBytes(output: Output, bytes: Buffer): void {
  if (bytes.length !== output.bytes || hashBytes(bytes) !== output.sha256) invalid('Output size/hash mismatch');
  if (output.role === 'project-file' && bytes.length === 0) return;
  const detected = sniffMime(bytes);
  if (output.mime === 'text/markdown') {
    if (detected !== 'text/plain' || !bytes.toString('utf8').trim()) invalid('Invalid Markdown bytes');
  } else {
    if (!mimeMatchesBytes(output.mime, detected)) invalid('Output MIME does not match bytes');
    // Structural truncation checks supplement BlobStore MIME verification. These
    // are validation fixtures, not evidence of real backend image generation.
    if (detected === 'image/png') {
      let offset = 8, end = false, rowBytes = 0, height = 0;
      const compressed: Buffer[] = [];
      while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
        if (size > bytes.length - offset - 12) invalid('Truncated PNG');
        let crc = 0xffffffff;
        for (const byte of bytes.subarray(offset + 4, offset + 8 + size)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
        if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(offset + 8 + size)) invalid('Corrupt PNG chunk checksum');
        if (offset === 8) {
          if (kind !== 'IHDR' || size !== 13) invalid('Invalid PNG header');
          const width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
          const depth = bytes[offset + 16]!, color = bytes[offset + 17]!;
          const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
          if (!width || !height || width * height > 40000000 || !channels || ![1, 2, 4, 8, 16].includes(depth) || (color === 3 && depth === 16) || (![0, 3].includes(color) && depth < 8) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) invalid('Unsupported PNG dimensions/encoding (non-interlaced required)');
          rowBytes = Math.ceil(width * channels * depth / 8) + 1;
          if (rowBytes * height > MAX_TOTAL) invalid('Decoded PNG exceeds limit');
        } else if (kind === 'IHDR') invalid('Duplicate PNG header');
        if (kind === 'IDAT' && size > 0) compressed.push(bytes.subarray(offset + 8, offset + 8 + size));
        offset += size + 12;
        if (kind === 'IEND') { end = size === 0 && offset === bytes.length; break; }
      }
      if (!compressed.length || !end) invalid('Incomplete PNG');
      let decoded: Buffer;
      try { decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowBytes * height }); } catch { return invalid('Invalid PNG compressed data'); }
      if (decoded.length !== rowBytes * height) invalid('PNG pixel data length mismatch');
      for (let row = 0; row < height; row++) if (decoded[row * rowBytes]! > 4) invalid('Invalid PNG row filter');
    } else if (detected === 'image/jpeg') {
      if (bytes.length < 32 || !bytes.subarray(-2).equals(Buffer.from([255, 217]))) invalid('Incomplete JPEG');
      let offset = 2, frame = false, scan = false;
      while (offset < bytes.length - 2) {
        if (bytes[offset++] !== 255) invalid('Invalid JPEG marker');
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (offset + 2 > bytes.length) invalid('Truncated JPEG segment');
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) invalid('Invalid JPEG segment length');
        if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
          if (length < 8) invalid('Invalid JPEG frame');
          const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
          if (!width || !height || width * height > 40000000) invalid('Invalid JPEG dimensions');
          frame = true;
        }
        if (marker === 0xda) { scan = offset + length < bytes.length - 2; break; }
        offset += length;
      }
      if (!frame || !scan) invalid('JPEG requires frame and scan data');
    } else if (detected === 'image/gif') {
      if (bytes.length < 14 || bytes.at(-1) !== 59 || !bytes.readUInt16LE(6) || !bytes.readUInt16LE(8) || bytes.readUInt16LE(6) * bytes.readUInt16LE(8) > 40000000) invalid('Incomplete/oversized GIF');
      let offset = 13 + (bytes[10]! & 128 ? 3 * (2 ** ((bytes[10]! & 7) + 1)) : 0), frames = 0;
      while (offset < bytes.length - 1) {
        const marker = bytes[offset++];
        if (marker === 0x21) offset++;
        else if (marker === 0x2c) {
          if (offset + 10 >= bytes.length) invalid('Truncated GIF frame');
          const width = bytes.readUInt16LE(offset + 4), height = bytes.readUInt16LE(offset + 6), packed = bytes[offset + 8]!;
          if (!width || !height || width * height > 40000000 || ++frames > 256) invalid('GIF frame limit');
          offset += 9 + (packed & 128 ? 3 * (2 ** ((packed & 7) + 1)) : 0);
          if (bytes[offset]! < 2 || bytes[offset]! > 8) invalid('Invalid GIF encoding');
          offset++;
        } else invalid('Invalid GIF block');
        while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset]!;
        if (offset >= bytes.length) invalid('Truncated GIF block');
        offset++;
      }
      if (!frames || offset !== bytes.length - 1) invalid('GIF requires complete frame data');
    } else if (detected === 'image/webp') {
      if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid('Incomplete WebP');
      let offset = 12, image = false;
      while (offset + 8 <= bytes.length) {
        const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
        if (start + length > bytes.length) invalid('Truncated WebP chunk');
        let width = 0, height = 0;
        if (kind === 'VP8 ' && length >= 10) {
          if (!bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) invalid('Invalid VP8 frame');
          width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff; image = true;
        } else if (kind === 'VP8L' && length >= 5) {
          if (bytes[start] !== 47) invalid('Invalid VP8L frame');
          const bits = bytes.readUInt32LE(start + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; image = true;
        } else if (kind === 'VP8X' && length === 10) {
          width = bytes.readUIntLE(start + 4, 3) + 1; height = bytes.readUIntLE(start + 7, 3) + 1;
        } else if (['VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF'].includes(kind)) invalid('Unsupported WebP encoding');
        if ((width || height) && (!width || !height || width * height > 40000000)) invalid('WebP dimension limit');
        offset = start + length + (length & 1);
      }
      if (!image || offset !== bytes.length) invalid('WebP requires complete image data');
    }
  }
}

/** Validate API image bytes with the same structural checks used at publication. */
export function validateImageOutput(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' {
  const mime = sniffMime(bytes);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) invalid('API returned an unsupported image MIME');
  validatePublicationOutputBytes({ outputKey: 'image', path: 'image', mime, bytes: bytes.length, sha256: hashBytes(bytes) }, bytes);
  return mime as 'image/png' | 'image/jpeg' | 'image/webp';
}

/** File preparation never runs inside a transaction. Only this publisher may
 * interpret bridge result.answer; natural-language completion is not parsed. */
export class Publication {
  constructor(readonly db: DatabaseSync, readonly dirs: DataDirectories, readonly resources: Resources, readonly graphs: Graphs, readonly runs: Runs) {}

  private check(run: Run, token: RunToken): Run {
    const actual = this.runs.get(run.id), runtime = this.runs.runtime(run.id);
    if (actual.serviceId !== run.serviceId || actual.projectId !== run.projectId || actual.graphId !== run.graphId || actual.nodeId !== run.nodeId) invalid('Run scope mismatch');
    if (runtime.epoch !== token.epoch || runtime.revision !== token.revision) conflict('Stale publication callback');
    if (actual.status !== 'finalizing' || runtime.details.cancelRequested === true) conflict('Run is not publishable');
    return actual;
  }

  async publish(run: Run, token: RunToken): Promise<void> {
    if (this.db.isTransaction) throw new Error('Publication preparation must run outside a transaction');
    const actual = this.runs.get(run.id);
    if (actual.serviceId !== run.serviceId || actual.projectId !== run.projectId || actual.graphId !== run.graphId || actual.nodeId !== run.nodeId) invalid('Run scope mismatch');
    if (actual.status === 'succeeded') return; // Completed atomic commit is its replay marker.
    this.check(run, token);
    const root = runDirectories(this.dirs, run.id).output;
    const runtime = this.runs.runtime(run.id);
    const visualizeGeneration = runtime.details.kind === 'visualize_generation';
    const publicationVersion: 1 | 2 = runtime.details.kind === 'execution' && runtime.details.publicationVersion === 2 ? 2 : 1;
    const result = runtime.details.result;
    const saved = this.db.prepare('SELECT * FROM publication_manifests WHERE run_id=?').get(run.id);
    let selected: Manifest;
    let hostAnswer: Buffer | undefined;
    if (saved) {
      if (hashBytes(Buffer.from(String(saved.manifest))) !== saved.sha256) invalid('Corrupt persisted publication manifest');
      selected = parsePublicationManifest(JSON.parse(String(saved.manifest)), publicationVersion, visualizeGeneration);
    } else {
      let raw: Buffer | undefined;
      try { raw = await readPublicationOutput(root, 'manifest.json', MAX_MANIFEST); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (raw) selected = parsePublicationManifest(JSON.parse(raw.toString('utf8')), publicationVersion, visualizeGeneration);
      else {
        if (visualizeGeneration) invalid('Visualize generation requires an explicit page package manifest');
        if (!object(result) || typeof result.answer !== 'string' || !result.answer.trim() || Buffer.byteLength(result.answer) > MAX_TEXT) invalid('Successful protocol response requires answer or explicit manifest');
        hostAnswer = Buffer.from(result.answer as string, 'utf8');
        selected = publicationVersion === 2
          ? { version:2, outputs:[{ outputKey:'answer', role:'delivery-document', path:'answer.md', mime:'text/markdown', bytes:hostAnswer.length, sha256:hashBytes(hostAnswer) }] }
          : { outputs: [{ outputKey: 'answer', path: 'answer.md', mime: 'text/markdown', bytes: hostAnswer.length, sha256: hashBytes(hostAnswer) }] };
      }
    }
    // The app-server result crosses the JSON-RPC boundary as Unicode and is the
    // authoritative user-facing completion. Use it for execution delivery docs
    // so a Windows shell cannot silently replace non-ASCII text while writing
    // delivery.md. Explicit project files and Work Graph node files still use
    // their manifest-declared bytes. Rewrite the frozen manifest to describe the
    // bytes that are actually published, which also keeps restart replay stable.
    const executionAnswer = publicationVersion === 2 && runtime.details.kind === 'execution' && object(result) && typeof result.answer === 'string' && result.answer.trim() && Buffer.byteLength(result.answer) <= MAX_TEXT
      ? Buffer.from(result.answer, 'utf8')
      : undefined;
    if (executionAnswer) selected = { ...selected, outputs:selected.outputs.map(output => output.role === 'delivery-document' ? { ...output, bytes:executionAnswer.length, sha256:hashBytes(executionAnswer) } : output) };
    // On recovery an answer-only manifest is regenerated from the frozen bridge
    // result, never from a new graph snapshot or guessed completion message.
    const projectFiles = new ProjectFiles(this.db);
    const visualize = new VisualizePublication(this.graphs, this.resources);
    const prepared: { output: Output; bytes: Buffer; blob?: PreparedBlob; text?: string; changeToken?: string; visualize?: PreparedVisualizePublication; pageValue?: unknown; reservedId?: string }[] = [];
    const visualizeFeature = hasVisualizeFeature(this.runs.snapshot(run.id).features);
    if ((visualizeGeneration || selected.outputs.some(output => output.nodeType === 'visualize')) && !visualizeFeature) invalid('Visualize publication requires the frozen builtin visualize feature identity');
    if (runtime.details.kind === 'execution' && visualizeFeature && !selected.outputs.some(output => output.nodeType === 'visualize')) invalid('Selected visualize generation requires an explicit visualize page package output');
    try {
      for (const output of selected.outputs) {
        if (streamedProjectFile(output.role, output.mime)) {
          const verified = await projectFiles.fingerprint(run.projectId, output.path, output.bytes);
          if (verified.sha256 !== output.sha256) invalid('Project output SHA-256 mismatch: ' + output.outputKey);
          if (output.bytes && !mimeMatchesBytes(output.mime, sniffMime(verified.prefix))) invalid('Output MIME does not match bytes');
          prepared.push({ output, bytes:Buffer.alloc(0), changeToken:verified.changeToken });
          continue;
        }
        let bytes: Buffer;
        if (output.role === 'delivery-document' && executionAnswer) bytes = executionAnswer;
        else if (hostAnswer) bytes = hostAnswer;
        else if (output.role === 'project-file') {
          const current = await projectFiles.readRange(run.projectId, output.path, undefined, Math.min(Math.max(output.bytes, 1), MAX_TOTAL));
          bytes = current.bytes;
        }
        else {
          try { bytes = await readPublicationOutput(root, output.path, Math.min(output.bytes, MAX_TOTAL)); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || selected.outputs.length !== 1 || output.outputKey !== 'answer' || output.path !== 'answer.md' || !object(result) || typeof result.answer !== 'string') throw error;
            bytes = Buffer.from(result.answer);
          }
        }
        validatePublicationOutputBytes(output, bytes);
        if (output.nodeType === 'visualize' || visualizeGeneration && output.mime === 'application/json') {
          let page: unknown;
          try { page = JSON.parse(bytes.toString('utf8')); } catch { invalid('Visualize output must be a valid JSON page package'); }
          prepared.push({ output, bytes, pageValue: page });
          continue;
        }
        if (output.role === 'project-file') {
          const observation = (await projectFiles.stat(run.projectId, [output.path]))[0]!;
          if (observation.state !== 'available' || observation.bytes !== output.bytes) invalid('Project output changed during publication preflight');
          prepared.push({ output, bytes, ...(observation.changeToken === null ? {} : { changeToken:observation.changeToken }), ...(supportsText(output.mime) ? { text:bytes.toString('utf8') } : {}) });
        } else {
          const blob = await this.resources.prepareBytes(bytes, output.mime, output.sha256);
          prepared.push({ output, bytes, blob, ...(supportsText(output.mime) ? { text: bytes.toString('utf8') } : {}) });
        }
      }
      const generated = new Map(prepared.filter(item => item.blob && /^(image|video|audio)[/]/.test(item.output.mime)).map(item => {
        item.reservedId = randomUUID();
        return [item.output.outputKey, { resourceId: item.reservedId, resourceVersion: 1, mime: item.output.mime }];
      }));
      for (const item of prepared) if (item.pageValue !== undefined) item.visualize = await visualize.prepare(run, item.pageValue, generated);
      if (visualizeGeneration) {
        const page = prepared.find(item => item.visualize)?.visualize!.page;
        const used = new Set([...(page?.dependencies ?? []).flatMap(dependency => dependency.kind === 'resource' ? [dependency.resourceId] : []), ...collectVisualizeAssetReferences({ initialForm: page?.initialForm ?? {}, schema: page?.form.schema ?? {} } as unknown as Json).flatMap(asset => asset.kind === 'resource' ? [asset.resourceId] : [])]);
        if ([...generated.values()].some(asset => !used.has(asset.resourceId))) invalid('Visualize generation requires one JSON page package and only referenced media assets');
      }
      // Register verified asset identities before pages which reference them.
      prepared.sort((a, b) => Number(!!a.visualize) - Number(!!b.visualize));
      const serialized = canonicalJson(selected as unknown as Json), digest = hashBytes(Buffer.from(serialized));
      atomic(this.db, () => {
        this.check(run, token);
        this.db.prepare('INSERT OR IGNORE INTO publication_manifests(run_id,manifest,sha256) VALUES(?,?,?)').run(run.id, serialized, digest);
        if (this.db.prepare('SELECT sha256 FROM publication_manifests WHERE run_id=?').get(run.id)?.sha256 !== digest) conflict('Publication manifest already frozen');
      });
      atomic(this.db, () => {
        this.check(run, token); this.graphs.writable(run);
        const runtime = this.runs.runtime(run.id);
        const source = this.db.prepare('SELECT n.*,v.content AS node_content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.deleted=0').get(run.nodeId, run.graphId);
        if (!source) invalid('Publication target no longer exists');
        const kind = runtime.details.kind;
        if (!['execution', 'text_generation', 'image_generation', 'visualize_generation'].includes(String(kind))) invalid('Unknown publication kind');
        if ((kind === 'execution' && source.type !== 'execution') || (kind === 'text_generation' && source.type !== 'text') || (kind === 'image_generation' && source.type !== 'image') || (kind === 'visualize_generation' && (source.type !== 'visualize' || source.schema_version !== 1))) invalid('Publication target type changed');
        if (kind === 'image_generation' && prepared.filter(item => imageMime(item.output.mime)).length !== 1) invalid('Image generation requires exactly one validated image');
        const artifacts = prepared.map(item => {
          if (item.visualize) {
            const current: Json = kind === 'visualize_generation' ? JSON.parse(String(source.node_content)) as Json : { title:item.output.title!, prompt:this.runs.snapshot(run.id).prompt, inputBindings:[] };
            return { ...item, content:visualize.install(run, item.output.outputKey, item.visualize, current) as unknown as { [key: string]: Json } };
          }
          if (item.output.role === 'project-file') {
            const name = basename(item.output.path);
            const content: { [key: string]: Json } = {
              title:name, mime:item.output.mime, bytes:item.output.bytes, outputKey:item.output.outputKey, runId:run.id,
              source:{ kind:'project-file', serviceId:this.graphs.serviceId, projectId:run.projectId, relativePath:item.output.path },
              observation:{ state:'available', name, mime:item.output.mime, bytes:item.output.bytes, changeToken:item.changeToken ?? null },
              ...(item.text === undefined ? {} : { text:item.text }),
            };
            this.db.prepare('INSERT INTO project_file_outputs(run_id,output_key,project_id,relative_path,bytes,sha256) VALUES(?,?,?,?,?,?)').run(run.id,item.output.outputKey,run.projectId,item.output.path,item.output.bytes,item.output.sha256);
            return { ...item, content };
          }
          const resourceName = basename(item.output.path);
          const title = limitNodeTitle(item.output.title ?? resourceName);
          const created = item.reservedId ? { resource: commitTransferResource(this.resources, run, item.blob!, resourceName, item.reservedId) } : this.resources.createCanvasFromPrepared(run, item.blob!, resourceName);
          this.db.prepare('INSERT INTO canvas_outputs(run_id,graph_id,output_key,resource_id,resource_version) VALUES(?,?,?,?,1)').run(run.id, run.graphId, item.output.outputKey, created.resource.id);
          const resourceOutput: { [key: string]: Json } = { resourceId:created.resource.id, resourceVersion:1, name:resourceName, mime:item.output.mime, bytes:item.output.bytes, outputKey:item.output.outputKey, runId:run.id };
          const content: { [key: string]: Json } = item.output.role === 'workgraph-node' && item.output.nodeType === 'text'
            ? { title, text:item.text ?? '', outputKey:item.output.outputKey, runId:run.id, generatedOutput:resourceOutput }
            : { title, ...resourceOutput, ...(item.text === undefined ? {} : { text:item.text }) };
          return { ...item, ...created, content };
        });
        const document = publicationVersion === 2 ? artifacts.find(item => item.output.role === 'delivery-document')! : artifacts.find(item => item.output.mime === 'text/markdown')!;
        if (kind === 'execution') {
          const currentContent = JSON.parse(String(source.node_content)) as Json;
          const taskTitle = selected.executionTitle ?? promptRunTitle(this.runs.snapshot(run.id).prompt);
          if (taskTitle && object(currentContent) && (currentContent.title === undefined || currentContent.title === '' || DEFAULT_EXECUTION_TITLES.has(String(currentContent.title)))) {
            this.append(run, Number(source.current_version), { ...currentContent, title:taskTitle });
          }
          const hideOutputs = !!this.db.prepare("SELECT 1 FROM edges WHERE graph_id=? AND source_id=? AND kind='execution' LIMIT 1").get(run.graphId, run.nodeId);
          const visibleArtifacts = artifacts.some(item => item.output.role === 'workgraph-node') ? artifacts.filter(item => item.output.role !== 'delivery-document') : artifacts;
          const layoutGroups = hideOutputs ? [] : this.db.prepare("SELECT n.id,n.x,n.y,n.width,n.height FROM graph_groups g JOIN nodes n ON n.id=g.id AND n.graph_id=g.graph_id JOIN group_members m ON m.group_id=g.id AND m.node_id=? WHERE g.graph_id=? AND g.run_id IS NULL AND n.type='group' AND n.schema_version=1 AND n.deleted=0 AND n.width IS NOT NULL AND n.height IS NOT NULL").all(run.nodeId, run.graphId)
            .sort((a, b) => Number(a['width']) * Number(a['height']) - Number(b['width']) * Number(b['height']) || String(a['id']).localeCompare(String(b['id'])));
          const documentId = randomUUID(); const nodeIds: string[] = [];
          for (const [index, item] of visibleArtifacts.entries()) {
            const id = item === document ? documentId : randomUUID(); nodeIds.push(id);
            const projectType = item.output.role === 'project-file' ? classifyProjectFile(item.output.path).type : null;
            const nodeType = item.output.role === 'workgraph-node' ? item.output.nodeType! : projectType ?? (imageMime(item.output.mime) || item.output.mime === 'image/svg+xml' ? 'image' : supportsText(item.output.mime) ? 'document' : 'file');
            const x = Math.min(1e9, Number(source.x) + Number(source.width ?? 300) + 100);
            const y = Math.min(1e9, Number(source.y) + index * 280);
            const size = item.visualize?.page.layout ?? (item.visualize ? VISUALIZE_DEFAULT_SIZE : undefined);
            this.graphs.insertNode(run, { id, type: nodeType, schemaVersion: 1, contentVersion: 1, content: item.content, x, y, ...(size ?? {}), readOnly: !item.visualize }, true);
            // Match the Web's default 300x220 output bounds; partial overlap must not
            // make a node move with a group that does not actually contain it.
            const group = layoutGroups.find(g => x >= Number(g['x']) && y >= Number(g['y']) && x + (size?.width ?? 300) <= Number(g['x']) + Number(g['width']) && y + (size?.height ?? 220) <= Number(g['y']) + Number(g['height']));
            if (group) this.db.prepare('INSERT INTO group_members(group_id,node_id) VALUES(?,?)').run(String(group['id']), id);
          }
          const edge = (sourceId: string, targetId: string, edgeKind: 'delivery' | 'reference'): void => {
            const id = randomUUID(); this.graphs.validateEdge(run, { id, sourceId, targetId, kind: edgeKind }, true);
            this.db.prepare('INSERT INTO edges(id,graph_id,source_id,target_id,kind) VALUES(?,?,?,?,?)').run(id, run.graphId, sourceId, targetId, edgeKind);
          };
          for (const id of nodeIds) {
            if (this.db.prepare('SELECT type FROM nodes WHERE id=?').get(id)?.type === 'visualize') visualize.delivery(run, id);
            else edge(run.nodeId, id, 'delivery');
          }
          // Register output ownership through delivery edges before hiding intermediate results.
          // The output folder and dependency snapshots still retain access to the published resources.
          if (hideOutputs) for (const id of nodeIds) {
            this.db.prepare("DELETE FROM edges WHERE target_id=? AND kind='delivery'").run(id);
            this.db.prepare("DELETE FROM canvas_resource_references WHERE owner_kind='node' AND node_id=?").run(id);
            this.db.prepare('UPDATE nodes SET deleted=1 WHERE id=?').run(id);
          }
          if (!hideOutputs && visibleArtifacts.length > 1) {
            const groupId = randomUUID(); this.db.prepare('INSERT INTO graph_groups(id,graph_id,run_id,title) VALUES(?,?,?,?)').run(groupId, run.graphId, run.id, 'Run outputs');
            for (const id of nodeIds) this.db.prepare('INSERT INTO group_members(group_id,node_id) VALUES(?,?)').run(groupId, id);
          }
        } else if (kind === 'visualize_generation') {
          if (source.read_only) invalid('Generation target is read-only');
          const primary = artifacts.find(item => item.visualize);
          if (!primary) invalid('Visualize generation requires a validated page package');
          if (source.current_version === (runtime.details.titleVersion ?? runtime.details.baseVersion)) {
            this.append(run, Number(source.current_version), primary.content);
            visualize.resize(run, run.nodeId, primary.content);
          } else this.db.prepare("INSERT INTO generation_candidates(run_id,node_id,base_version,content,state) VALUES(?,?,?,?,'pending')").run(run.id, run.nodeId, Number(runtime.details.baseVersion), canonicalJson(primary.content));
        } else {
          if (source.read_only) invalid('Generation target is read-only');
          const primary = kind === 'text_generation' ? document : artifacts.find(item => imageMime(item.output.mime))!;
          if (!('resource' in primary)) invalid('Generation outputs must use Work Graph resources');
          const primaryResource = primary.resource as CanvasResource;
          const currentContent = JSON.parse(String(source.node_content)) as Json;
          const content: Json = kind === 'text_generation'
            ? typeof primary.text === 'string'
              ? generatedTextContent(currentContent, primary.text, {
                  resourceId: primaryResource.id, resourceVersion: primaryResource.current.version,
                  name: basename(primary.output.path), mime: primary.output.mime,
                })
              : invalid('Text generation target requires editable text content')
            : generatedImageContent(currentContent, { ...primary.content, title: generatedTextTitle(document.text ?? ''), outputs: artifacts.map(item => item.content) });
          if (Buffer.byteLength(canonicalJson(content)) > 2 * MAX_TEXT) invalid('Generation content exceeds node content limit');
          if (source.current_version === (runtime.details.titleVersion ?? runtime.details.baseVersion)) this.append(run, Number(source.current_version), content);
          else this.db.prepare("INSERT INTO generation_candidates(run_id,node_id,base_version,content,state) VALUES(?,?,?,?,'pending')").run(run.id, run.nodeId, Number(runtime.details.baseVersion), canonicalJson(content));
        }
        for (const item of artifacts) if ('referenceId' in item) this.resources.releaseCanvasReference(run, item.referenceId);
        this.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1,layout_revision=layout_revision+? WHERE id=?').run(kind === 'execution' || kind === 'visualize_generation' && source.current_version === (runtime.details.titleVersion ?? runtime.details.baseVersion) ? 1 : 0, run.graphId);
        this.graphs.event(run);
        this.runs.transition(run.id, token, 'succeeded', { publicationDigest: digest });
        this.graphs.history.completeRun(run,run.id,true);
      });
    } finally {
      atomic(this.db, () => { for (const item of prepared) if (item.blob) this.resources.discardPrepared(item.blob); });
      for (const item of prepared) if (item.visualize) await visualize.dispose(item.visualize);
      await this.resources.drainFileDeletions();
    }
  }

  private append(run: Run, expected: number, content: Json): void {
    content = limitNodeContentTitle(content);
    if (this.db.prepare('SELECT type FROM nodes WHERE id=?').get(run.nodeId)?.type === 'visualize') {
      const previous = this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(run.nodeId, expected);
      new VisualizePublication(this.graphs, this.resources).validate(run, previous ? JSON.parse(String(previous.content)) as Json : null, content);
    }
    if (Buffer.byteLength(canonicalJson(content)) > 2 * MAX_TEXT) invalid('Generation content exceeds node content limit');
    const changed = this.db.prepare('UPDATE nodes SET current_version=current_version+1 WHERE id=? AND graph_id=? AND current_version=? AND read_only=0 AND deleted=0').run(run.nodeId, run.graphId, expected);
    if (changed.changes !== 1) conflict('Generation target changed');
    this.db.prepare('INSERT INTO node_versions(node_id,version,content) VALUES(?,?,?)').run(run.nodeId, expected + 1, canonicalJson(content));
    this.graphs.retainResources(run, run.nodeId, expected + 1, content);
  }

  /** Main's authenticated route must supply full scope. No implicit acceptance. */
  decide(request: CandidateDecision): { state: 'accepted' | 'discarded'; contentVersion: number } {
    return atomic(this.db, () => {
      if (!['accept', 'discard'].includes(request.decision) || !Number.isSafeInteger(request.expectedContentVersion) || request.expectedContentVersion < 1) invalid('Invalid candidate decision');
      this.graphs.writable(request); const run = this.runs.get(request.runId);
      if (run.serviceId !== request.serviceId || run.projectId !== request.projectId || run.graphId !== request.graphId) invalid('Candidate scope mismatch');
      const candidate = this.db.prepare('SELECT * FROM generation_candidates WHERE run_id=?').get(run.id);
      if (!candidate || candidate.state !== 'pending') conflict('Candidate is no longer pending');
      const node = this.db.prepare('SELECT * FROM nodes WHERE id=? AND graph_id=? AND deleted=0').get(run.nodeId, run.graphId);
      if (!node || node.current_version !== request.expectedContentVersion || node.read_only) conflict('Candidate target changed');
      const state = request.decision === 'accept' ? 'accepted' : 'discarded';
      if (request.decision === 'accept') {
        const proposed = JSON.parse(String(candidate.content)) as Json;
        const runtime = this.runs.runtime(run.id);
        if (runtime.details.kind === 'text_generation') {
          const current = this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(run.nodeId, request.expectedContentVersion);
          const existing = current ? JSON.parse(String(current.content)) as Json : null;
          if (!object(proposed) || typeof proposed.text !== 'string') invalid('Text generation candidate requires editable text content');
          this.append(run, request.expectedContentVersion, generatedTextContent(existing, proposed.text, proposed.generatedOutput as Json | undefined, proposed.title as string));
        } else if (runtime.details.kind === 'visualize_generation') {
          if (node.type !== 'visualize' || node.schema_version !== 1) invalid('Visualize candidate target type changed');
          const current = this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(run.nodeId, request.expectedContentVersion);
          const visualize = new VisualizePublication(this.graphs, this.resources);
          const content = visualize.accept(run, current ? JSON.parse(String(current.content)) as Json : null, proposed) as unknown as Json;
          this.append(run, request.expectedContentVersion, content);
          visualize.resize(run, run.nodeId, content);
        } else {
          const current = this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(run.nodeId, request.expectedContentVersion);
          this.append(run, request.expectedContentVersion, generatedImageContent(current ? JSON.parse(String(current.content)) as Json : null, proposed));
        }
      }
      if (this.db.prepare("UPDATE generation_candidates SET state=? WHERE run_id=? AND state='pending'").run(state, run.id).changes !== 1) conflict('Candidate already decided');
      this.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1,layout_revision=layout_revision+? WHERE id=?').run(request.decision === 'accept' && this.runs.runtime(run.id).details.kind === 'visualize_generation' ? 1 : 0, run.graphId); this.graphs.event(run);
      this.runs.record(run.id, 'generation.' + state, { contentVersion: request.expectedContentVersion });
      return { state, contentVersion: request.expectedContentVersion + Number(request.decision === 'accept') };
    });
  }
}
