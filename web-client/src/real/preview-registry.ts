import type { ComponentType } from 'react';
import type { GraphSnapshot, Node } from './contracts';
import { previewFormat, type PreviewMode } from './preview-formats';
import { builtInPreviewRenderers } from './preview-renderers';
import { translate } from '../i18n/translate';

export interface PreviewFile { name: string; mime: string }
export interface PreviewRendererProps extends PreviewFile { blob: Blob; text: string }
export interface PreviewRendererDefinition {
  id: string;
  label: string;
  matches: (file: PreviewFile) => boolean;
  /** Blob renderers (e.g. PDF) own decoding; text renderers get bounded UTF-8. */
  input: 'text' | 'blob';
  /** Fill renderers own their viewport; use PreviewLayout for stationary paging. */
  layout?: 'scroll' | 'fill';
  /** Metadata-first viewers wait for the user before mounting/decoding content. */
  initialView?: 'content' | 'metadata';
  modes: readonly PreviewMode[];
  defaultMode: PreviewMode;
  Component?: ComponentType<PreviewRendererProps>;
}
export type PreviewSource =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'inline-file'; name: string; text: string; mime: string }
  | { kind: 'empty-project-file'; name: string; relativePath: string }
  | { kind: 'project-file'; name: string; relativePath: string; mime: string }
  | { kind: 'image' | 'file'; name: string; resourceId: string; version: number; mime: string };
export interface PreviewSourceDefinition {
  type: string;
  schemaVersion: number;
  resolve: (node: Node) => PreviewSource | undefined;
}
export type ResolvedPreviewSource =
  | { state: 'empty' | 'unsupported' | 'invalid' }
  | { state: 'ready'; nodeId: string; source: PreviewSource };

const renderers: PreviewRendererDefinition[] = [...builtInPreviewRenderers];
const sourceResolvers: PreviewSourceDefinition[] = ['text','image','file','document','video'].map(type => ({
  type, schemaVersion: 1,
  resolve(node) {
    const c = node.content && typeof node.content === 'object' && !Array.isArray(node.content) ? node.content : {};
    const name = typeof c.title === 'string' ? c.title : translate('Predecessor resource');
    const source = c.source && typeof c.source === 'object' && !Array.isArray(c.source) ? c.source : {};
    if (source.kind === 'project-file-empty') return {kind:'empty-project-file',name,relativePath:typeof source.relativePath === 'string' ? source.relativePath : ''};
    if (source.kind === 'project-file' && typeof source.relativePath === 'string' && source.relativePath)
      return {kind:'project-file',name,relativePath:source.relativePath,mime:typeof c.mime === 'string' ? c.mime : ''};
    // Older imports stored CSV as text. Render its current body through the file
    // registry, without migrating the node or reading a stale attached resource.
    if (type === 'text' && previewFormat(name, typeof c.mime === 'string' ? c.mime : '') === 'csv') return {kind:'inline-file',name,text:String(c.text ?? ''),mime:'text/csv'};
    // Inline text is authoritative, including generated text retaining an old resource.
    if (type === 'text' || (!c.resourceId && typeof c.text === 'string')) return {kind:'text',name,text:String(c.text ?? '')};
    if (typeof c.resourceId !== 'string' || !Number.isSafeInteger(c.resourceVersion) || Number(c.resourceVersion) < 1) return undefined;
    return {kind:type === 'image' ? 'image' : 'file',name,resourceId:c.resourceId,version:Number(c.resourceVersion),mime:typeof c.mime === 'string' ? c.mime : ''};
  },
}));
const listeners = new Set<() => void>();
let version = 0;
export const getPreviewRegistryVersion = () => version;
export function subscribePreviewRegistry(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function changed() { version++; for (const listener of [...listeners]) listener(); }
function register<T extends object>(registry: T[], definition: T): () => void {
  const registered = Object.freeze({...definition});
  registry.push(registered); changed();
  let active = true;
  return () => { if (!active) return; active = false; registry.splice(registry.indexOf(registered),1); changed(); };
}
/** Trusted application code only. Graph JSON never loads components or code URLs.
 * Newest matching layer wins; disposal is idempotent and safe out of order. */
export function registerPreviewRenderer(definition: PreviewRendererDefinition): () => void {
  if (!definition?.id?.trim() || !definition.label?.trim() || typeof definition.matches !== 'function' || !['text','blob'].includes(definition.input) ||
    !Array.isArray(definition.modes) || !definition.modes.length || definition.modes.some(mode => !['rendered','text','hex'].includes(mode)) ||
    !definition.modes.includes(definition.defaultMode) || (definition.modes.includes('rendered') && typeof definition.Component !== 'function')) throw Error(translate('Invalid preview renderer registration.'));
  return register(renderers, {...definition,modes:Object.freeze([...definition.modes])});
}
export function registerPreviewSource(definition: PreviewSourceDefinition): () => void {
  if (!definition?.type?.trim() || definition.type === 'preview' || !Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 1 || typeof definition.resolve !== 'function') throw Error(translate('Invalid preview predecessor resolver registration.'));
  return register(sourceResolvers, definition);
}
export function resolvePreviewRenderer(file: PreviewFile): PreviewRendererDefinition {
  return [...renderers].reverse().find(renderer => renderer.matches(file))!;
}
/** Resolve one reference hop only. Never walk arbitrary ancestors or copy resources. */
export function resolvePreviewSource(graph: GraphSnapshot, nodeId: string): ResolvedPreviewSource {
  const edges = graph.edges.filter(edge => edge.targetId === nodeId && edge.kind === 'reference');
  if (!edges.length) return {state:'empty'};
  if (edges.length !== 1) return {state:'invalid'};
  const node = graph.nodes.find(node => node.id === edges[0].sourceId);
  if (!node || node.type === 'preview') return {state:'invalid'};
  const resolver = [...sourceResolvers].reverse().find(item => item.type === node.type && item.schemaVersion === node.schemaVersion);
  if (!resolver) return {state:'unsupported'};
  const source = resolver.resolve(node);
  return source ? {state:'ready',nodeId:node.id,source} : {state:'empty'};
}
