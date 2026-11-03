import type { ModelMessage, UserContent } from 'ai';
import type { BuiltinAgentModel, BuiltinAgentProtocol } from '@openworkgraph/protocol';
import type { BackendRunContext } from '../../backend/types.js';
import { AgentError } from '../errors.js';
import type { BuiltinAgentFiles } from './files.js';
import { builtinAssertMediaFormat, builtinMediaKind, builtinProjectMediaMime } from './media.js';

const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
type Parts = Exclude<UserContent, string>;
/** Ordinary files/directories/documents can be inspected with tools.
 * This also applies to saved connections created before file support was added. */
export function builtinModelInputKinds(model: Pick<BuiltinAgentModel, 'inputKinds'>): BuiltinAgentModel['inputKinds'] {
  return [...new Set([...model.inputKinds, 'document' as const, 'file' as const])];
}
/** Preserve input order and original source identity. Only accepted local bytes
 * enter the SDK: no external-media downloads, OCR, transcoding or model swaps. */
export function builtinInputMessages(context: BackendRunContext, model: BuiltinAgentModel, files: BuiltinAgentFiles, protocol: BuiltinAgentProtocol = 'responses'): ModelMessage[] {
  const parts: Parts = [{ type: 'text', text: context.prompt }]; let bytes = 0;
  const inputKinds = builtinModelInputKinds(model);
  for (const resource of context.resources ?? []) {
    const native = resource.resource && builtinMediaKind(resource.resource.mime);
    if (!inputKinds.includes(native && resource.kind !== 'file' ? native : resource.kind)) throw new AgentError('capability_unsupported');
    parts.push({ type: 'text', text: 'Frozen upstream input: ' + JSON.stringify({ kind: resource.kind, sourceNodeIds: resource.sourceNodeIds, resource: resource.resource }) });
    if (resource.text !== null) parts.push({ type: 'text', text: resource.text });
    if (!resource.resource) { if (resource.kind !== 'text' && !resource.text) throw new AgentError('invalid_configuration'); continue; }
    const reference = resource.resource, materialized = context.files?.find(file => file.resourceId === reference.resourceId && file.version === reference.version);
    if (!materialized || materialized.sha256 !== reference.sha256) throw new AgentError('invalid_configuration');
    const content = files.bytes(materialized.path);
    if (content.sha256 !== reference.sha256 || content.content.length !== reference.bytes) throw new AgentError('invalid_configuration');
    bytes += content.content.length; if (bytes > 4 * 1024 * 1024) throw new AgentError('input_size_limit');
    if (resource.kind === 'image') {
      if (!images.has(reference.mime)) throw new AgentError('capability_unsupported');
      parts.push({ type: 'file', mediaType: reference.mime, data: { type: 'data', data: content.content } });
    } else if (native && model.inputKinds.includes(native)) {
      builtinAssertMediaFormat(reference.mime, protocol);
      parts.push({ type: 'file', mediaType: reference.mime, data: { type: 'data', data: content.content } });
    } else if (resource.kind === 'video' || resource.kind === 'audio') {
      throw new AgentError('capability_unsupported');
    } else if (resource.kind === 'document' && model.inputKinds.includes('document') && reference.mime === 'application/pdf') {
      if (!content.content.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new AgentError('invalid_configuration');
      parts.push({ type: 'file', mediaType: reference.mime, filename: reference.resourceId + '.pdf', data: { type: 'data', data: content.content } });
    } else if (reference.mime.startsWith('text/') || reference.mime === 'application/json') {
      if (resource.text === null) parts.push({ type: 'text', text: new TextDecoder('utf8', { fatal: true }).decode(content.content) });
    } else if (resource.kind === 'file' || resource.kind === 'document') {
      parts.push({ type: 'text', text: 'Binary input is available only as a frozen file for tools, not as model-native media: ' + JSON.stringify({ path: content.path, sha256: content.sha256, bytes: reference.bytes, mime: reference.mime }) });
    } else if (!resource.text) throw new AgentError('capability_unsupported');
  }
  for (const input of context.projectFiles ?? []) {
    if (!inputKinds.includes(input.kind)) throw new AgentError('capability_unsupported');
    const path = files.path(input.relativePath);
    if (input.entryKind === 'directory') { parts.push({ type: 'text', text: 'Project directory input (read it with tools): ' + path }); continue; }
    const source = files.bytes(path); bytes += source.content.length; if (bytes > 4 * 1024 * 1024) throw new AgentError('input_size_limit');
    parts.push({ type: 'text', text: 'Project file input: ' + JSON.stringify({ ...input, sha256: source.sha256 }) });
    const mediaType = builtinProjectMediaMime(input.relativePath), native = mediaType && builtinMediaKind(mediaType);
    if (native && (input.kind === 'file' || input.kind === native) && model.inputKinds.includes(native)) {
      builtinAssertMediaFormat(mediaType!, protocol);
      parts.push({ type: 'file', mediaType: mediaType!, data: { type: 'data', data: source.content } });
    } else if (input.kind === 'text') parts.push({ type: 'text', text: new TextDecoder('utf8', { fatal: true }).decode(source.content) });
    else if (input.kind === 'image') {
      const mime = /[.](png|jpe?g|webp|gif)$/i.exec(input.relativePath)?.[1]?.toLowerCase();
      if (!mime) throw new AgentError('capability_unsupported');
      parts.push({ type: 'file', mediaType: 'image/' + (mime === 'jpg' ? 'jpeg' : mime), data: { type: 'data', data: source.content } });
    } else if (input.kind === 'document' && model.inputKinds.includes('document') && source.content.subarray(0, 5).equals(Buffer.from('%PDF-'))) parts.push({ type: 'file', mediaType: 'application/pdf', filename: 'project-input.pdf', data: { type: 'data', data: source.content } });
    else if (input.kind === 'file' || input.kind === 'document') parts.push({ type: 'text', text: 'Binary project file for tools only: ' + path });
    else throw new AgentError('capability_unsupported');
  }
  return [{ role: 'user', content: parts }];
}
