import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TERMINAL_RUN_STATUSES, type GraphDocumentHistory, type GraphHistoryTravel, type GraphScope, type Json } from '@openworkgraph/protocol';
import type { Graphs } from './graphs.js';
import { resourceLinks } from './graphs.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { restoreVisualizeContent } from './visualize-transfer.js';

type Row = Record<string, SQLInputValue>;
interface Document { title: string; nodes: Row[]; edges: Row[]; groups: Row[]; members: Row[]; outputs: Row[] }
interface Checkpoint { document: Document; execution: number; layout: number; run: number }
const TTL = 24 * 60 * 60 * 1000;
const MAX_VERSIONS = 51;
const MAX_BYTES = 64 * 1024 * 1024;
const empty = (): GraphDocumentHistory => ({ cursor: null, canUndo: false, canRedo: false, expiresAt: null });

/** One shared document timeline per graph. Only graph command transactions append versions. */
export class GraphDocumentVersions {
  constructor(private graphs: Graphs, private db: DatabaseSync = graphs.db) {}
  private runSequence(id: string): number {
    return Number(this.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM runs WHERE graph_id=?').get(id)!['n']);
  }
  private active(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM runs WHERE graph_id=? AND status NOT IN (' + TERMINAL_RUN_STATUSES.map(() => '?').join(',') + ') UNION ALL SELECT 1 FROM occupancy o JOIN runs r ON r.id=o.run_id WHERE r.graph_id=? LIMIT 1').get(id, ...TERMINAL_RUN_STATUSES, id);
  }
  private head(id: string) { return this.db.prepare('SELECT * FROM graph_document_heads WHERE graph_id=?').get(id); }
  private valid(scope: GraphScope) {
    const graph = this.graphs.scope(scope), head = this.head(scope.graphId);
    return head && Number(head['expires_at']) > Date.now() && !graph['archived'] && !graph['trashed']
      && head['execution_revision'] === graph['execution_revision'] && head['layout_revision'] === graph['layout_revision']
      && head['run_sequence'] === this.runSequence(scope.graphId) ? head : undefined;
  }
  state(scope: GraphScope): GraphDocumentHistory {
    const head = this.valid(scope);
    if (!head) return empty();
    const cursor = Number(head['cursor']);
    const gates = this.db.prepare('SELECT g.run_id,r.status FROM graph_document_run_gates g JOIN runs r ON r.id=g.run_id WHERE g.graph_id=? AND g.cursor=? ORDER BY r.sequence').all(scope.graphId,cursor);
    if (this.active(scope.graphId) && !this.db.prepare('SELECT 1 FROM graph_document_run_gates WHERE graph_id=? LIMIT 1').get(scope.graphId)) return empty();
    return { cursor: String(cursor), expiresAt: Number(head['expires_at']), undoRunIds:gates.filter(g=>!TERMINAL_RUN_STATUSES.includes(String(g['status']) as typeof TERMINAL_RUN_STATUSES[number])).map(g=>String(g['run_id'])),
      canUndo: gates.length>0 || !!this.db.prepare('SELECT 1 FROM graph_document_versions WHERE graph_id=? AND id<? LIMIT 1').get(scope.graphId, cursor),
      canRedo: !!this.db.prepare('SELECT 1 FROM graph_document_versions WHERE graph_id=? AND id>? LIMIT 1').get(scope.graphId, cursor) };
  }
  capture(scope: GraphScope): Checkpoint {
    const graph = this.graphs.scope(scope), id = scope.graphId;
    const document: Document = {
      title: String(graph['title']),
      nodes: this.db.prepare('SELECT n.id,n.type,n.schema_version,n.x,n.y,n.width,n.height,n.read_only,n.read_only_reason,n.deleted,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.graph_id=? AND (n.deleted=0 OR EXISTS(SELECT 1 FROM execution_outputs o WHERE o.node_id=n.id)) ORDER BY n.creation_order').all(id),
      edges: this.db.prepare('SELECT id,source_id,target_id,kind FROM edges WHERE graph_id=? ORDER BY id').all(id),
      groups: this.db.prepare('SELECT id,run_id,title FROM graph_groups WHERE graph_id=? ORDER BY id').all(id),
      members: this.db.prepare('SELECT m.group_id,m.node_id FROM group_members m JOIN graph_groups g ON g.id=m.group_id WHERE g.graph_id=? ORDER BY m.group_id,m.node_id').all(id),
      outputs: this.db.prepare('SELECT o.node_id,o.execution_node_id FROM execution_outputs o JOIN nodes n ON n.id=o.node_id WHERE n.graph_id=? ORDER BY o.node_id').all(id),
    };
    return { document, execution: Number(graph['execution_revision']), layout: Number(graph['layout_revision']), run: this.runSequence(id) };
  }
  clear(id: string) {
    this.db.prepare('DELETE FROM graph_document_heads WHERE graph_id=?').run(id);
    this.db.prepare('DELETE FROM graph_document_versions WHERE graph_id=?').run(id);
  }
  private append(scope: GraphScope, document: Document): number {
    const id = Number(this.db.prepare('INSERT INTO graph_document_versions(graph_id,document) VALUES(?,?)').run(scope.graphId, canonicalJson(document as unknown as Json)).lastInsertRowid);
    for (const node of document.nodes) for (const link of resourceLinks(JSON.parse(String(node['content'])) as Json,String(node['type']))) {
      this.db.prepare('INSERT OR IGNORE INTO graph_document_resources(version_id,resource_id,resource_version) VALUES(?,?,?)').run(id, link.resourceId, link.version);
    }
    return id;
  }
  private anchorActiveRuns(graphId: string, cursor: number, excludeRunId?: string) {
    const statuses=TERMINAL_RUN_STATUSES.map(()=>'?').join(',');
    this.db.prepare(
      'INSERT OR IGNORE INTO graph_document_run_gates(run_id,graph_id,cursor) '
      + 'SELECT r.id,r.graph_id,? FROM runs r WHERE r.graph_id=? AND r.status NOT IN ('+statuses+') '
      + 'AND r.id<>? AND NOT EXISTS(SELECT 1 FROM graph_document_run_gates g WHERE g.run_id=r.id)',
    ).run(cursor,graphId,...TERMINAL_RUN_STATUSES,excludeRunId??'');
  }
  /** Upgrade an already-running graph from the pre-gate history format. */
  backfillActiveGates() {
    const rows=this.db.prepare('SELECT r.id,r.graph_id,r.project_id FROM runs r WHERE r.status NOT IN ('+TERMINAL_RUN_STATUSES.map(()=>'?').join(',')+') AND NOT EXISTS(SELECT 1 FROM graph_document_run_gates g WHERE g.run_id=r.id) ORDER BY r.sequence').all(...TERMINAL_RUN_STATUSES);
    for (const row of rows) {
      const scope={serviceId:this.graphs.serviceId,projectId:String(row['project_id']),graphId:String(row['graph_id'])};
      this.db.exec('SAVEPOINT history_gate_backfill');
      try {
        const head=this.head(scope.graphId);
        const graph=this.graphs.scope(scope);
        if (!head || Number(head['expires_at'])<=Date.now() || head['execution_revision']!==graph['execution_revision'] || head['layout_revision']!==graph['layout_revision']) {
          this.clear(scope.graphId);
          const snapshot=this.capture(scope);
          const cursor=this.append(scope,snapshot.document);
          this.db.prepare('INSERT INTO graph_document_heads VALUES(?,?,?,?,?,?)').run(scope.graphId,cursor,snapshot.execution,snapshot.layout,snapshot.run,Date.now()+TTL);
        } else {
          // Legacy submissions advanced runs.sequence without updating the existing history head.
          this.db.prepare('UPDATE graph_document_heads SET run_sequence=? WHERE graph_id=?').run(this.runSequence(scope.graphId),scope.graphId);
        }
        this.db.prepare('INSERT OR IGNORE INTO graph_document_run_gates(run_id,graph_id,cursor) VALUES(?,?,?)').run(row['id']!,scope.graphId,this.head(scope.graphId)!['cursor']!);
        this.db.exec('RELEASE history_gate_backfill');
      } catch(error) { this.db.exec('ROLLBACK TO history_gate_backfill; RELEASE history_gate_backfill'); throw error; }
    }
  }
  /** A submitted Run is a one-way gate anchored after the last editable version. */
  recordRunSubmission(scope: GraphScope, runId: string, before: Checkpoint) {
    if (!this.db.isTransaction) throw Error('Run history gate requires the submission transaction');
    const id=scope.graphId, after=this.capture(scope);
    let head=this.head(id);
    if (!head || Number(head['expires_at'])<=Date.now() || head['execution_revision']!==before.execution || head['layout_revision']!==before.layout || head['run_sequence']!==before.run) {
      this.clear(id);
      const baseline=this.append(scope,before.document);
      this.db.prepare('INSERT INTO graph_document_heads VALUES(?,?,?,?,?,?)').run(id,baseline,before.execution,before.layout,before.run,Date.now()+TTL);
      head=this.head(id)!;
    }
    let cursor=Number(head['cursor']);
    // A history reset may have cascaded an older active Run's gate. Re-anchor it
    // before this submission's own document change, which gets a separate gate.
    this.anchorActiveRuns(id,cursor,runId);
    this.db.prepare('DELETE FROM graph_document_versions WHERE graph_id=? AND id>?').run(id,cursor);
    if (canonicalJson(before.document as unknown as Json)!==canonicalJson(after.document as unknown as Json)) {
      cursor=this.append(scope,after.document);
    }
    this.db.prepare('INSERT INTO graph_document_run_gates(run_id,graph_id,cursor) VALUES(?,?,?)').run(runId,id,cursor);
    this.db.prepare('UPDATE graph_document_heads SET cursor=?,execution_revision=?,layout_revision=?,run_sequence=? WHERE graph_id=?').run(cursor,after.execution,after.layout,after.run,id);
  }
  /** Run publication may advance graph revisions outside the user command queue. */
  completeRun(scope: GraphScope, runId: string, published = false) {
    if (!this.db.isTransaction) throw Error('Run history settlement requires a transaction');
    const gate=this.db.prepare('SELECT cursor FROM graph_document_run_gates WHERE graph_id=? AND run_id=?').get(scope.graphId,runId);
    if (!gate) return;
    const head=this.head(scope.graphId);
    if (!head) return;
    const current=this.capture(scope);
    if (!published) return;
    const stored=this.db.prepare('SELECT document FROM graph_document_versions WHERE id=? AND graph_id=?').get(head['cursor']!,scope.graphId);
    if (!stored) return;
    const before=JSON.parse(String(stored['document'])) as Document;
    const after=current.document;
    const collections: {field:keyof Pick<Document,'nodes'|'edges'|'groups'|'members'|'outputs'>; key:(row:Row)=>string}[]=[
      {field:'nodes',key:row=>String(row['id'])}, {field:'edges',key:row=>String(row['id'])},
      {field:'groups',key:row=>String(row['id'])}, {field:'members',key:row=>JSON.stringify([row['group_id'],row['node_id']])},
      {field:'outputs',key:row=>String(row['node_id'])},
    ];
    for (const version of this.db.prepare('SELECT id,document FROM graph_document_versions WHERE graph_id=?').all(scope.graphId)) {
      const document=JSON.parse(String(version['document'])) as Document;
      if (before.title!==after.title) document.title=after.title;
      for (const {field,key} of collections) {
        const oldRows=new Map(before[field].map(row=>[key(row),row]));
        const nextRows=new Map(after[field].map(row=>[key(row),row]));
        const changed=new Set([...oldRows.keys(),...nextRows.keys()].filter(id=>canonicalJson((oldRows.get(id)??null) as Json)!==canonicalJson((nextRows.get(id)??null) as Json)));
        document[field]=document[field].filter(row=>!changed.has(key(row)) || nextRows.has(key(row))).map(row=>{
          const id=key(row), old=oldRows.get(id), next=nextRows.get(id);
          if (!changed.has(id) || !old || !next) return row;
          const merged={...row};
          for (const [name,value] of Object.entries(next)) if (canonicalJson((old[name]??null) as Json)!==canonicalJson((value??null) as Json)) merged[name]=value;
          return merged;
        });
        for (const [id,row] of nextRows) if (changed.has(id) && !document[field].some(item=>key(item)===id)) document[field].push(row);
      }
      this.db.prepare('UPDATE graph_document_versions SET document=? WHERE id=?').run(canonicalJson(document as unknown as Json),version['id']!);
      this.db.prepare('DELETE FROM graph_document_resources WHERE version_id=?').run(version['id']!);
      for (const node of document.nodes) for (const link of resourceLinks(JSON.parse(String(node['content'])) as Json,String(node['type'])))
        this.db.prepare('INSERT OR IGNORE INTO graph_document_resources(version_id,resource_id,resource_version) VALUES(?,?,?)').run(version['id']!,link.resourceId,link.version);
    }
    this.db.prepare('UPDATE graph_document_heads SET execution_revision=?,layout_revision=?,run_sequence=? WHERE graph_id=?').run(current.execution,current.layout,current.run,scope.graphId);
  }
  record(scope: GraphScope, before: Checkpoint, boundary = false) {
    if (!this.db.isTransaction) throw Error('Document history requires the command transaction');
    const after = this.capture(scope), id = scope.graphId;
    if (boundary) { this.clear(id); return; }
    let head = this.head(id);
    if (!head || Number(head['expires_at']) <= Date.now() || head['execution_revision'] !== before.execution || head['layout_revision'] !== before.layout || head['run_sequence'] !== before.run) {
      this.clear(id);
      const baseline = this.append(scope, before.document);
      this.db.prepare('INSERT INTO graph_document_heads VALUES(?,?,?,?,?,?)').run(id, baseline, before.execution, before.layout, before.run, Date.now() + TTL);
      head = this.head(id)!;
    }
    let cursor = Number(head['cursor']);
    // Keep active Runs gated even when a stale head required a new baseline.
    // Also repair a missing gate before appending the current user command.
    this.anchorActiveRuns(id,cursor);
    if (canonicalJson(before.document as unknown as Json) !== canonicalJson(after.document as unknown as Json)) {
      this.db.prepare('DELETE FROM graph_document_versions WHERE graph_id=? AND id>?').run(id, cursor);
      cursor = this.append(scope, after.document);
    }
    this.db.prepare('UPDATE graph_document_heads SET cursor=?,execution_revision=?,layout_revision=?,run_sequence=? WHERE graph_id=?').run(cursor, after.execution, after.layout, after.run, id);
    const versions = this.db.prepare('SELECT id,length(CAST(document AS BLOB)) AS bytes FROM graph_document_versions WHERE graph_id=? ORDER BY id DESC').all(id);
    let bytes = 0;
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i]!; bytes += Number(v['bytes']);
      if ((i >= MAX_VERSIONS || bytes > MAX_BYTES) && Number(v['id']) < cursor) this.db.prepare('DELETE FROM graph_document_versions WHERE id=?').run(v['id']!);
    }
  }
  travel(request: GraphHistoryTravel, principal: string) {
    if (!['undo','redo'].includes(request.direction) || typeof request.expectedCursor !== 'string' || !request.expectedCursor || !Number.isSafeInteger(request.expectedExecutionRevision) || !Number.isSafeInteger(request.expectedLayoutRevision)) throw new ServiceError('INVALID_REQUEST', '撤销重做需要方向、历史游标和整数修订号。');
    return this.graphs.repo.idempotent(principal + ':graph.history:' + request.graphId, request.idempotencyKey, request as unknown as Json, () => {
      const graph = this.graphs.writable(request);
      const head = this.valid(request);
      if (this.active(request.graphId) && !this.db.prepare('SELECT 1 FROM graph_document_run_gates WHERE graph_id=? LIMIT 1').get(request.graphId)) throw new ServiceError('ACTIVE_RUN','图中存在正在运行的任务，请先等待任务结束。');
      if (!head || String(head['cursor']) !== request.expectedCursor || graph['execution_revision'] !== request.expectedExecutionRevision || graph['layout_revision'] !== request.expectedLayoutRevision) throw new ServiceError('REVISION_CONFLICT', '工作图或历史版本已变化，请读取最新状态后重试。');
      const gates=request.direction==='undo' ? this.db.prepare('SELECT g.run_id,r.status FROM graph_document_run_gates g JOIN runs r ON r.id=g.run_id WHERE g.graph_id=? AND g.cursor=?').all(request.graphId,Number(head['cursor'])) : [];
      if (gates.some(g=>!TERMINAL_RUN_STATUSES.includes(String(g['status']) as typeof TERMINAL_RUN_STATUSES[number]))) throw new ServiceError('ACTIVE_RUN','请先确认停止正在运行的任务，并等待运行时完成收尾。');
      const target = this.db.prepare('SELECT id,document FROM graph_document_versions WHERE graph_id=? AND id' + (request.direction === 'undo' ? '<' : '>') + '? ORDER BY id ' + (request.direction === 'undo' ? 'DESC' : 'ASC') + ' LIMIT 1').get(request.graphId, Number(head['cursor']));
      if (!target && !gates.length) throw new ServiceError('CONFLICT', request.direction === 'undo' ? '没有可撤销操作。' : '没有可重做操作。');
      if (gates.length) this.db.prepare('DELETE FROM graph_document_run_gates WHERE graph_id=? AND cursor=?').run(request.graphId,Number(head['cursor']));
      if (!target) return this.graphs.snapshot(request) as unknown as Json;
      this.restore(request, JSON.parse(String(target['document'])) as Document);
      this.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1,layout_revision=layout_revision+1 WHERE id=?').run(request.graphId);
      this.db.prepare('UPDATE graph_document_heads SET cursor=?,execution_revision=?,layout_revision=? WHERE graph_id=?').run(target['id']!, request.expectedExecutionRevision + 1, request.expectedLayoutRevision + 1, request.graphId);
      this.graphs.event(request);
      return this.graphs.snapshot(request) as unknown as Json;
    });
  }
  private restore(scope: GraphScope, doc: Document) {
    const id = scope.graphId;
    // Stable node identities preserve selection and Run foreign keys. Body versions never rewind.
    this.db.prepare('DELETE FROM edges WHERE graph_id=?').run(id);
    this.db.prepare('DELETE FROM group_members WHERE group_id IN (SELECT id FROM graph_groups WHERE graph_id=?)').run(id);
    this.db.prepare('DELETE FROM graph_groups WHERE graph_id=?').run(id);
    this.db.prepare('DELETE FROM execution_outputs WHERE node_id IN (SELECT id FROM nodes WHERE graph_id=?)').run(id);
    this.db.prepare("DELETE FROM canvas_resource_references WHERE graph_id=? AND owner_kind='node'").run(id);
    const live = new Set(doc.nodes.map(n => String(n['id'])));
    for (const n of this.db.prepare('SELECT id FROM nodes WHERE graph_id=? AND deleted=0').all(id)) if (!live.has(String(n['id']))) {
      this.db.prepare('UPDATE nodes SET deleted=1,undo_expires_at=NULL WHERE id=?').run(n['id']!);
      this.db.prepare('DELETE FROM node_resource_history WHERE node_id=?').run(n['id']!);
    }
    for (let n of doc.nodes) {
      const current = this.db.prepare('SELECT n.*,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=?').get(n['id']!, id);
      if (!current) throw new ServiceError('CONFLICT', '历史节点已不存在，无法恢复。');
      if (n['type'] === 'visualize' && current['type'] === 'visualize' && current['content'] !== n['content']) {
        n = { ...n, content: canonicalJson(restoreVisualizeContent(this.db, scope, String(n['id']), JSON.parse(String(n['content'])) as Json, JSON.parse(String(current['content'])) as Json)) };
      }
      let version = Number(current['current_version']);
      if (current['content'] !== n['content'] || current['type'] !== n['type'] || current['deleted'] !== n['deleted']) {
        version = Number(this.db.prepare('SELECT max(version)+1 AS n FROM node_versions WHERE node_id=?').get(n['id']!)!['n']);
        this.db.prepare('INSERT INTO node_versions(node_id,version,content) VALUES(?,?,?)').run(n['id']!, version, n['content']!);
      }
      this.db.prepare('UPDATE nodes SET type=?,schema_version=?,current_version=?,x=?,y=?,width=?,height=?,read_only=?,read_only_reason=?,deleted=?,undo_expires_at=NULL WHERE id=?').run(n['type']!, n['schema_version']!, version, n['x']!, n['y']!, n['width']!, n['height']!, n['read_only']!, n['read_only_reason']!, n['deleted']!, n['id']!);
      this.graphs.retainResources(scope, String(n['id']), version, JSON.parse(String(n['content'])) as Json);
      if (n['deleted']) this.db.prepare("DELETE FROM canvas_resource_references WHERE owner_kind='node' AND node_id=?").run(n['id']!);
    }
    for (const g of doc.groups) this.db.prepare('INSERT INTO graph_groups(id,graph_id,run_id,title) VALUES(?,?,?,?)').run(g['id']!, id, g['run_id']!, g['title']!);
    for (const m of doc.members) this.db.prepare('INSERT INTO group_members(group_id,node_id) VALUES(?,?)').run(m['group_id']!, m['node_id']!);
    for (const o of doc.outputs) this.db.prepare('INSERT INTO execution_outputs(node_id,execution_node_id) VALUES(?,?)').run(o['node_id']!, o['execution_node_id']!);
    for (const e of doc.edges) this.db.prepare('INSERT INTO edges(id,graph_id,source_id,target_id,kind) VALUES(?,?,?,?,?)').run(e['id']!, id, e['source_id']!, e['target_id']!, e['kind']!);
    this.db.prepare('UPDATE graphs SET title=? WHERE id=?').run(doc.title, id);
  }
}
