import { randomId } from '../adapter/random';
import type { GraphSnapshot } from './contracts';
import type { GraphHistoryTravel, Json, VisualizeFormSnapshot, VisualizeStateSnapshot } from '../../../packages/protocol/src/index';
import { visualizeGraphContent } from '../../../packages/protocol/src/visualize-history';
import { validateVisualizeNodeContent } from '../../../packages/protocol/src/visualize-validation';
import { translate } from '../i18n/translate';

export interface DocumentTimeline {
  versions: { id: string; graph: GraphSnapshot }[];
  cursor: number;
  expiresAt: number;
  executionRevision: number;
  layoutRevision: number;
}
type VisualizeData = { form: VisualizeFormSnapshot; state: VisualizeStateSnapshot };
export interface VersionedDocument { graph: GraphSnapshot; timeline?: DocumentTimeline; nodeVersions?: Record<string, number>; visualizeData?: Record<string, VisualizeData> }
const TTL = 24 * 60 * 60 * 1000;
const empty = () => ({ cursor:null, canUndo:false, canRedo:false, expiresAt:null });
const content = (g: GraphSnapshot) => ({ title:g.title, nodes:g.nodes.map(({contentVersion:_, ...n}) => n.type==='visualize' ? { ...n, content:visualizeGraphContent(n.content) } : n), edges:g.edges, hiddenExecutionOutputs:g.hiddenExecutionOutputs });
function dataKey(id: string, value: Json) {
  const content = validateVisualizeNodeContent(value);
  return content.page ? JSON.stringify([id, content.page.resource.resourceId, content.page.resource.resourceVersion]) : undefined;
}
function rememberVisualizeData(record: VersionedDocument, graph: GraphSnapshot, nodeId?: string) {
  record.visualizeData ??= {};
  for (const n of graph.nodes) if (n.type==='visualize' && (!nodeId || n.id===nodeId)) {
    const content = validateVisualizeNodeContent(n.content), key = dataKey(n.id, n.content);
    if (key && content.form && content.state) record.visualizeData[key] = structuredClone({form:content.form, state:content.state});
  }
}
function pruneVisualizeData(record: VersionedDocument) {
  const retained = new Set<string>();
  for (const graph of [record.graph, ...(record.timeline?.versions.map(v=>v.graph)??[])]) for (const node of graph.nodes) if (node.type==='visualize') {
    const key = dataKey(node.id, node.content); if (key) retained.add(key);
  }
  for (const key of Object.keys(record.visualizeData??{})) if (!retained.has(key)) delete record.visualizeData![key];
}
/** Acknowledges a page save without copying, scanning, or truncating graph versions. */
export function recordVisualizeInteraction(record: VersionedDocument, next: GraphSnapshot, nodeId?: string) {
  const t = valid(record);
  rememberVisualizeData(record, next, nodeId);
  if (t) { t.executionRevision = next.executionRevision; t.layoutRevision = next.layoutRevision; }
  record.nodeVersions ??= {};
  for (const n of next.nodes) if (!nodeId || n.id===nodeId) record.nodeVersions[n.id] = Math.max(record.nodeVersions[n.id]??0,n.contentVersion);
  record.graph = next;
  record.graph = documentSnapshot(record);
}
function valid(record: VersionedDocument) {
  const t = record.timeline, g = record.graph;
  return t && t.expiresAt > Date.now() && t.executionRevision === g.executionRevision && t.layoutRevision === g.layoutRevision && !g.archived && !g.trashed ? t : undefined;
}
export function documentSnapshot(record: VersionedDocument): GraphSnapshot {
  const t = valid(record);
  return { ...record.graph, history:t ? { cursor:t.versions[t.cursor]!.id, canUndo:t.cursor>0, canRedo:t.cursor<t.versions.length-1, expiresAt:t.expiresAt } : empty() };
}
function snapshot(g: GraphSnapshot): GraphSnapshot { const {history:_, ...value}=g; return structuredClone(value); }
export function recordDocumentVersion(record: VersionedDocument, next: GraphSnapshot, boundary = false) {
  const before = record.graph;
  if (!boundary && JSON.stringify(content(before))===JSON.stringify(content(next))) { recordVisualizeInteraction(record, next); return; }
  rememberVisualizeData(record, before); rememberVisualizeData(record, next);
  let t = valid(record);
  if (!t) t = { versions:[{id:randomId(),graph:snapshot(before)}], cursor:0, expiresAt:Date.now()+TTL, executionRevision:before.executionRevision, layoutRevision:before.layoutRevision };
  record.nodeVersions ??= {};
  for (const n of [...before.nodes,...next.nodes]) record.nodeVersions[n.id] = Math.max(record.nodeVersions[n.id] ?? 0,n.contentVersion);
  if (JSON.stringify(content(before)) !== JSON.stringify(content(next))) {
    t.versions = t.versions.slice(0,t.cursor+1);
    t.versions.push({id:randomId(),graph:snapshot(next)});
    t.cursor = t.versions.length-1;
  }
  let bytes = t.versions.reduce((n,v)=>n+new TextEncoder().encode(JSON.stringify(v.graph)).length,0);
  while (t.cursor>0 && (t.versions.length>51 || bytes>64*1024*1024)) {
    bytes -= new TextEncoder().encode(JSON.stringify(t.versions.shift()!.graph)).length; t.cursor--;
  }
  t.executionRevision = next.executionRevision; t.layoutRevision = next.layoutRevision;
  record.graph = next;
  record.timeline = boundary ? undefined : t;
  pruneVisualizeData(record);
  record.graph = documentSnapshot(record);
}
export function travelDocumentVersion(record: VersionedDocument, request: Pick<GraphHistoryTravel,'direction'|'expectedCursor'|'expectedExecutionRevision'|'expectedLayoutRevision'>): GraphSnapshot {
  const t = valid(record), current = record.graph;
  if (!['undo','redo'].includes(request.direction)) throw Error(translate('Invalid history direction.'));
  if (!t || t.versions[t.cursor]!.id !== request.expectedCursor || current.executionRevision !== request.expectedExecutionRevision || current.layoutRevision !== request.expectedLayoutRevision)
    throw Object.assign(Error(translate('The Work Graph history changed. Refresh and try again.')), {code:'REVISION_CONFLICT'});
  const target = t.cursor + (request.direction === 'undo' ? -1 : 1);
  if (target<0 || target>=t.versions.length) throw Error(request.direction==='undo' ? translate('There is nothing to undo.') : translate('There is nothing to redo.'));
  const graph = snapshot(t.versions[target]!.graph);
  // Seed old IndexedDB records once; current confirmed data takes precedence.
  if (!record.visualizeData) for (const v of t.versions) rememberVisualizeData(record, v.graph);
  rememberVisualizeData(record, current);
  record.nodeVersions ??= {};
  for (const n of graph.nodes) {
    if (n.type==='visualize') {
      const key = dataKey(n.id, n.content), data = key ? record.visualizeData?.[key] : undefined;
      if (data) n.content = { ...(n.content as Record<string, Json>), form:structuredClone(data.form) as unknown as Json, state:structuredClone(data.state) as unknown as Json };
    }
    const live = current.nodes.find(v=>v.id===n.id), counter = Math.max(record.nodeVersions[n.id]??0,live?.contentVersion??0,n.contentVersion);
    n.contentVersion = live && live.type===n.type && JSON.stringify(live.content)===JSON.stringify(n.content) ? live.contentVersion : counter+1;
    record.nodeVersions[n.id] = n.contentVersion;
  }
  graph.executionRevision = current.executionRevision+1; graph.layoutRevision = current.layoutRevision+1;
  graph.eventCursor = current.eventCursor;
  graph.updatedAt = new Date().toISOString();
  t.cursor=target; t.executionRevision=graph.executionRevision; t.layoutRevision=graph.layoutRevision;
  record.graph=graph;
  return record.graph=documentSnapshot(record);
}
