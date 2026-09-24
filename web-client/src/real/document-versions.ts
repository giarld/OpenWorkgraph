import { randomId } from '../adapter/random';
import type { GraphSnapshot } from './contracts';
import type { GraphHistoryTravel } from '../../../packages/protocol/src/index';
import { translate } from '../i18n/translate';

export interface DocumentTimeline {
  versions: { id: string; graph: GraphSnapshot }[];
  cursor: number;
  expiresAt: number;
  executionRevision: number;
  layoutRevision: number;
}
export interface VersionedDocument { graph: GraphSnapshot; timeline?: DocumentTimeline; nodeVersions?: Record<string, number> }
const TTL = 24 * 60 * 60 * 1000;
const empty = () => ({ cursor:null, canUndo:false, canRedo:false, expiresAt:null });
const content = (g: GraphSnapshot) => ({ title:g.title, nodes:g.nodes.map(({contentVersion:_, ...n}) => n), edges:g.edges, hiddenExecutionOutputs:g.hiddenExecutionOutputs });
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
  record.nodeVersions ??= {};
  for (const n of graph.nodes) {
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
