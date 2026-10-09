import { GraphDocumentVersions } from './graph-document-history.js';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteGraph, Edge, GraphCommand, GraphScope, GraphSnapshot, Json, Node } from '@openworkgraph/protocol';
import { WORKGRAPH_UPLOAD_MAX_BYTES, TERMINAL_RUN_STATUSES, executionOrder, limitNodeContentTitle, limitNodeTitleOperations } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { atomic } from './persistence/database.js';
import { canonicalJson, Repositories } from './persistence/repositories.js';
import { previewEdgeError } from '@openworkgraph/protocol';
import { PluginRegistry } from './plugins.js';
import type { Resources } from './resources.js';
const BUILTINS=new Set(['text','image','document','video','file','preview','execution','group']);
export function assertProjectWritable(db:DatabaseSync,id:string):void {
  const row=db.prepare('SELECT state FROM projects WHERE id=?').get(id);
  if (!row) throw new ServiceError('NOT_FOUND','项目不存在。');
  if (row['state']!=='active') throw new ServiceError('PROJECT_INACTIVE','停用项目只读。');
}
function identifier(value:unknown):asserts value is string { if (typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new ServiceError('INVALID_REQUEST','无效的标识。'); }
function title(value:unknown):asserts value is string { if(typeof value!=='string'||!value.trim()||value.length>1024) throw new ServiceError('INVALID_REQUEST','名称必须非空且不超过 1024 字符。'); }
function position(value:unknown):asserts value is number { if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e9) throw new ServiceError('INVALID_REQUEST','无效的位置。'); }
export function nodeDimension(value:unknown):asserts value is number {if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e9)throw new ServiceError('INVALID_REQUEST','节点尺寸必须为正有限数且不超过 1e9。');}
function boundedContent(value:Json):void {
  let count=0; const visit=(v:Json,depth:number):void=>{if(depth>32||++count>100000) throw new ServiceError('INVALID_REQUEST','节点内容过深或过大。');if(v&&typeof v==='object')for(const item of Object.values(v))visit(item,depth+1);};visit(value,0);
  if(Buffer.byteLength(canonicalJson(value))>2*1024*1024)throw new ServiceError('PAYLOAD_TOO_LARGE','单节点内容不能超过 2 MiB。');
}
export function resourceLinks(content:Json):{resourceId:string;version:number}[] {
  const result=new Map<string,{resourceId:string;version:number}>();
  const visit=(value:Json):void=>{if(!value||typeof value!=='object')return;
    if(!Array.isArray(value)&&typeof value['resourceId']==='string') {const version=value['resourceVersion']??value['version'];if(typeof version!=='number'||!Number.isSafeInteger(version)||version<1)throw new ServiceError('INVALID_REQUEST','画布资源必须固定版本。');result.set(value['resourceId']+':'+version,{resourceId:value['resourceId'],version});}
    for(const item of Object.values(value))visit(item);};visit(content);return [...result.values()];
}
export class Graphs {
  readonly repo:Repositories;
  readonly history:GraphDocumentVersions;
  private readonly pageKey=randomBytes(32);
  private readonly pageEpoch=randomUUID();
  constructor(readonly db:DatabaseSync,readonly serviceId:string){this.repo=new Repositories(db);this.history=new GraphDocumentVersions(this,db);}
  scope(scope:GraphScope):Record<string,unknown>{
    if(scope.serviceId!==this.serviceId)throw new ServiceError('SERVICE_MISMATCH','服务身份不匹配。');
    const row=this.db.prepare('SELECT * FROM graphs WHERE id=? AND project_id=?').get(scope.graphId,scope.projectId);
    if(!row)throw new ServiceError('NOT_FOUND','工作图不存在。');return row;
  }
  writable(scope:GraphScope,allowArchived=false):Record<string,unknown>{const graph=this.scope(scope);assertProjectWritable(this.db,scope.projectId);if(graph['trashed']||(graph['archived']&&!allowArchived))throw new ServiceError('CONFLICT','归档或回收站工作图只读。');return graph;}
  snapshot(scope:GraphScope):GraphSnapshot{return atomic(this.db,()=>{
    const graph=this.scope(scope);
    const rows=this.db.prepare('SELECT n.*,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.graph_id=? AND n.deleted=0 ORDER BY n.created_at,n.creation_order').all(scope.graphId);
    const groups=new Map(this.db.prepare('SELECT g.id,g.title FROM graph_groups g JOIN nodes n ON n.id=g.id AND n.graph_id=g.graph_id WHERE g.graph_id=? AND g.run_id IS NULL AND n.type=\'group\' AND n.deleted=0').all(scope.graphId).map(row=>[String(row['id']),String(row['title'])]));
    const members=new Map<string,string[]>();
    for(const row of this.db.prepare('SELECT m.group_id,m.node_id FROM group_members m JOIN graph_groups g ON g.id=m.group_id JOIN nodes n ON n.id=m.node_id WHERE g.graph_id=? AND n.graph_id=? AND n.deleted=0 ORDER BY n.created_at,n.creation_order').all(scope.graphId,scope.graphId)){const id=String(row['group_id']);const ids=members.get(id)??[];ids.push(String(row['node_id']));members.set(id,ids);}
    const outputNames=new Map(this.db.prepare("SELECT o.node_id,r.name FROM execution_outputs o JOIN nodes n ON n.id=o.node_id JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version JOIN canvas_resources r ON r.id=json_extract(v.content,'$.resourceId') AND r.graph_id=n.graph_id WHERE n.graph_id=?").all(scope.graphId).map(row=>[String(row['node_id']),String(row['name'])]));
    const asNode=(row:Record<string,unknown>):Node=>{
      let content=groups.has(String(row['id']))?{title:groups.get(String(row['id']))!}:JSON.parse(String(row['content'])) as Json;
      const name=outputNames.get(String(row['id']));
      // Presentation fallback for immutable legacy versions, including hidden outputs.
      if(row['read_only']&&name&&content&&typeof content==='object'&&!Array.isArray(content)&&(typeof content['title']!=='string'||!content['title'].trim()))content={...content,title:name};
      return {id:String(row['id']),type:String(row['type']),schemaVersion:Number(row['schema_version']),contentVersion:Number(row['current_version']),content,x:Number(row['x']),y:Number(row['y']),...(row['width']===null?{}:{width:Number(row['width'])}),...(row['height']===null?{}:{height:Number(row['height'])}),...(groups.has(String(row['id']))?{memberIds:members.get(String(row['id']))??[]}:{}),readOnly:Boolean(row['read_only'])};
    };
    const nodes=rows.map(asNode);
    const hiddenExecutionOutputs=this.db.prepare('SELECT n.*,v.content,o.execution_node_id FROM execution_outputs o JOIN nodes n ON n.id=o.node_id JOIN nodes owner ON owner.id=o.execution_node_id JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.graph_id=? AND n.deleted=1 AND owner.deleted=0 ORDER BY n.created_at,n.creation_order').all(scope.graphId).map(row=>({executionNodeId:String(row['execution_node_id']),node:asNode(row)}));
    const edges:Edge[]=this.db.prepare('SELECT e.* FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id WHERE e.graph_id=? AND s.deleted=0 AND t.deleted=0 ORDER BY e.id').all(scope.graphId).map(row=>({id:String(row['id']),sourceId:String(row['source_id']),targetId:String(row['target_id']),kind:row['kind'] as Edge['kind']}));
    return {...scope,...(graph['updated_at'] ? {updatedAt:String(graph['updated_at'])} : {}),title:String(graph['title']),archived:Boolean(graph['archived']),trashed:Boolean(graph['trashed']),executionRevision:Number(graph['execution_revision']),layoutRevision:Number(graph['layout_revision']),eventCursor:String(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.['seq']??0),nodes,edges,hiddenExecutionOutputs,history:this.history.state(scope)};
  });}
  list(projectId:string,includeArchived=false,includeInactive=false,trashed=false):GraphSnapshot[]{return atomic(this.db,()=>{
    const project=this.db.prepare('SELECT state FROM projects WHERE id=?').get(projectId);if(!project)throw new ServiceError('NOT_FOUND','项目不存在。');
    if(project['state']!=='active'&&!includeInactive)return [];
    return this.db.prepare('SELECT id FROM graphs WHERE project_id=? AND trashed=? AND (? OR archived=0) ORDER BY id').all(projectId,Number(trashed),Number(includeArchived)).map(row=>this.snapshot({serviceId:this.serviceId,projectId,graphId:String(row['id'])}));
  });}
  /** Read-only pagination; no saved snapshots, idempotency records or GC work.
   * One transaction fingerprints and reads the list. Cursors survive unrelated
   * service events, but not project graph changes or a service restart. */
  page(projectId:string,request:Record<string,unknown>,principal:string):{items:GraphSnapshot[];nextCursor:string|null;snapshotId:string;eventCursor:string}{
    identifier(projectId);
    if(Object.keys(request).some(key=>!['filter','limit','cursor'].includes(key))
      ||!['all','trashed'].includes(String(request['filter']))||typeof request['filter']!=='string'
      ||!Number.isSafeInteger(request['limit'])||Number(request['limit'])<1||Number(request['limit'])>100
      ||('cursor' in request&&(typeof request['cursor']!=='string'||!request['cursor']||request['cursor'].length>4096)))
      throw new ServiceError('INVALID_REQUEST','分页需要 filter=all|trashed、limit=1..100 和可选 cursor。');
    const filter=request['filter'],limit=Number(request['limit']);
    let prior:Record<string,unknown>|undefined;
    if(typeof request['cursor']==='string'){
      const parts=request['cursor'].split('.');
      try{
        if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))throw new Error();
        const bytes=Buffer.from(parts[0]!,'base64url');
        if(bytes.toString('base64url')!==parts[0])throw new Error();
        const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
        prior=value as Record<string,unknown>;
        if(Object.keys(prior).sort().join(',')!=='epoch,eventCursor,filter,offset,principal,projectId,serviceId,snapshotId,v'
          ||prior['v']!==1||prior['serviceId']!==this.serviceId||prior['projectId']!==projectId||prior['filter']!==filter||prior['principal']!==principal
          ||typeof prior['epoch']!=='string'||typeof prior['snapshotId']!=='string'||!/^[a-f0-9]{64}$/.test(prior['snapshotId'])
          ||!Number.isSafeInteger(prior['offset'])||Number(prior['offset'])<1
          ||typeof prior['eventCursor']!=='string'||!/^\d+$/.test(prior['eventCursor'])||!Number.isSafeInteger(Number(prior['eventCursor'])))throw new Error();
      }catch{throw new ServiceError('INVALID_REQUEST','分页游标格式无效或不属于当前服务、项目、筛选及会话。');}
      if(prior['epoch']!==this.pageEpoch)throw new ServiceError('CURSOR_EXPIRED','服务已重启，请从第一页重新读取。');
      const signature=Buffer.from(parts[1]!,'base64url'),expected=createHmac('sha256',this.pageKey).update(parts[0]!).digest();
      if(signature.toString('base64url')!==parts[1]||signature.length!==expected.length||!timingSafeEqual(signature,expected))throw new ServiceError('INVALID_REQUEST','分页游标校验失败。');
    }
    return atomic(this.db,()=>{
      const items=this.list(projectId,true,true,filter==='trashed');
      const state=this.db.prepare('SELECT state FROM projects WHERE id=?').get(projectId)!['state'];
      // Keep the project event watermark in the fingerprint to catch change-then-
      // revert, including a graph created and purged between page requests.
      const graphWatermark=String(this.db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM events WHERE project_id=? AND type='graph.changed'").get(projectId)!['n']);
      const snapshotId=createHash('sha256').update(canonicalJson({serviceId:this.serviceId,projectId,filter,state,graphWatermark,items:items.map(({eventCursor:_,...graph})=>graph)} as unknown as Json)).digest('hex');
      const currentWatermark=String(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.['seq']??0);
      const eventFloor=Number(JSON.parse(String(this.db.prepare("SELECT value FROM settings WHERE key='eventFloor'").get()?.['value']??'0')));
      if(prior&&(prior['snapshotId']!==snapshotId||Number(prior['eventCursor'])>Number(currentWatermark)||Number(prior['eventCursor'])<eventFloor))throw new ServiceError('CURSOR_EXPIRED','工作图列表快照或事件水位已失效，请丢弃已累积页面并从第一页重读。');
      const offset=prior?Number(prior['offset']):0,eventCursor=prior?String(prior['eventCursor']):currentWatermark;
      if(prior&&offset>=items.length)throw new ServiceError('INVALID_REQUEST','分页游标位置无效。');
      const next=offset+limit;
      let nextCursor:string|null=null;
      if(next<items.length){
        const payload=Buffer.from(JSON.stringify({v:1,serviceId:this.serviceId,projectId,filter,principal,epoch:this.pageEpoch,snapshotId,eventCursor,offset:next})).toString('base64url');
        nextCursor=payload+'.'+createHmac('sha256',this.pageKey).update(payload).digest('base64url');
      }
      return {items:items.slice(offset,next).map(item=>({...item,eventCursor})),nextCursor,snapshotId,eventCursor};
    });
  }
  create(projectId:string,name:string,key:string,principal='local'):GraphSnapshot {title(name);identifier(projectId);return this.repo.idempotent(principal+':graph.create',key,{projectId,name},()=>{
    assertProjectWritable(this.db,projectId);const graphId=randomUUID();this.db.prepare('INSERT INTO graphs(id,project_id,title) VALUES(?,?,?)').run(graphId,projectId,name);
    const scope={serviceId:this.serviceId,projectId,graphId};this.event(scope);return this.snapshot(scope) as unknown as Json;
  }) as unknown as GraphSnapshot;}
  event(scope:GraphScope):void {const graph=this.scope(scope);this.repo.appendEvent({eventId:randomUUID(),type:'graph.changed',projectId:scope.projectId,graphId:scope.graphId,entityId:scope.graphId,revision:Number(graph['execution_revision']),occurredAt:new Date().toISOString(),payload:{executionRevision:Number(graph['execution_revision']),layoutRevision:Number(graph['layout_revision']),archived:Boolean(graph['archived']),trashed:Boolean(graph['trashed'])}});}
 activeNode(nodeId:string):boolean{return Boolean(this.db.prepare(`SELECT 1 FROM runs WHERE node_id=? AND status NOT IN (${TERMINAL_RUN_STATUSES.map(()=>'?').join(',')}) LIMIT 1`).get(nodeId,...TERMINAL_RUN_STATUSES));}
  private activeExecutionChainNodeIds(scope:GraphScope):Set<string> {
    const terminal=TERMINAL_RUN_STATUSES.map(()=>'?').join(',');
    const rows=this.db.prepare(`
      SELECT DISTINCT member.node_id
      FROM runs member
      JOIN run_runtime member_rt ON member_rt.run_id=member.id
      WHERE member.graph_id=?
        AND json_extract(member_rt.details,'$.chainBatch') IN (
          SELECT json_extract(active_rt.details,'$.chainBatch')
          FROM runs active
          JOIN run_runtime active_rt ON active_rt.run_id=active.id
          WHERE active.graph_id=?
            AND active.status NOT IN (${terminal})
            AND json_extract(active_rt.details,'$.chainBatch') IS NOT NULL
        )
    `).all(scope.graphId,scope.graphId,...TERMINAL_RUN_STATUSES);
    return new Set(rows.map(row=>String(row['node_id'])));
  }
  activeExecutionChain(scope:GraphScope):boolean {return this.activeExecutionChainNodeIds(scope).size>0;}
  private assertChainTopologyEditable(scope:GraphScope,operations:GraphCommand['operations']):void {
    const activeNodeIds=this.activeExecutionChainNodeIds(scope);
    if(!activeNodeIds.size)return;
    const blocked=operations.some(op=>{
      if(op.type==='edge.create')return op.edge.kind==='execution'&&(activeNodeIds.has(op.edge.sourceId)||activeNodeIds.has(op.edge.targetId));
      if(op.type==='edge.delete'){
        const edge=this.db.prepare('SELECT source_id,target_id,kind FROM edges WHERE id=? AND graph_id=?').get(op.edgeId,scope.graphId);
        return edge?.['kind']==='execution'&&(activeNodeIds.has(String(edge['source_id']))||activeNodeIds.has(String(edge['target_id'])));
      }
      if(op.type!=='node.delete'||this.db.prepare('SELECT 1 FROM execution_outputs WHERE node_id=?').get(op.nodeId))return false;
      if(activeNodeIds.has(op.nodeId))return true;
      return this.db.prepare("SELECT source_id,target_id FROM edges WHERE graph_id=? AND kind='execution' AND (source_id=? OR target_id=?)").all(scope.graphId,op.nodeId,op.nodeId).some(edge=>activeNodeIds.has(String(edge['source_id']))||activeNodeIds.has(String(edge['target_id'])));
    });
    if(blocked)throw new ServiceError('NODE_LOCKED','正在运行的串联成员及其执行连线不可删除或修改，请先停止整体调度并完成收尾。');
  }
  assertSettled(scope:GraphScope):void {
    if(this.db.prepare(`SELECT 1 FROM runs WHERE graph_id=? AND status NOT IN (${TERMINAL_RUN_STATUSES.map(()=>'?').join(',')}) LIMIT 1`).get(scope.graphId,...TERMINAL_RUN_STATUSES)
      ||this.db.prepare('SELECT 1 FROM occupancy o JOIN runs r ON r.id=o.run_id WHERE r.graph_id=? LIMIT 1').get(scope.graphId))
      throw new ServiceError('ACTIVE_RUN','图中任务须结束或取消并完成收尾。');
  }
  /** A lifecycle operation is never mixed with edits, even if it restores writability. */
  private lifecycle(scope:GraphScope,op:Extract<GraphCommand['operations'][number],{type:'graph.archive'|'graph.trash'}>):void {
    const graph=this.scope(scope);this.assertSettled(scope);
    if(op.type==='graph.archive'){
      if(typeof op.archived!=='boolean')throw new ServiceError('INVALID_REQUEST','归档值必须是布尔值。');
      if(graph['trashed']||Boolean(graph['archived'])===op.archived)throw new ServiceError('CONFLICT','不合法的归档状态转换。');
      this.db.prepare('UPDATE graphs SET archived=? WHERE id=?').run(Number(op.archived),scope.graphId);
    }else{
      if(typeof op.trashed!=='boolean')throw new ServiceError('INVALID_REQUEST','回收站值必须是布尔值。');
      if(Boolean(graph['trashed'])===op.trashed)throw new ServiceError('CONFLICT','不合法的回收站状态转换。');
      // Preserve the previous archive state across trash/restore.
      this.db.prepare('UPDATE graphs SET trashed=? WHERE id=?').run(Number(op.trashed),scope.graphId);
    }
  }
  permanentDelete(request:DeleteGraph,resources:Resources,principal='local'):{graphId:string;deleted:true}{
    if(!Number.isSafeInteger(request.expectedExecutionRevision)||!Number.isSafeInteger(request.expectedLayoutRevision)||typeof request.confirmTitle!=='string')throw new ServiceError('INVALID_REQUEST','彻底删除需要版本和确认名称。');
    return this.repo.idempotent(principal+':graph.delete:'+request.graphId,request.idempotencyKey,request as unknown as Json,()=>{
      const graph=this.scope(request);assertProjectWritable(this.db,request.projectId);this.assertSettled(request);
      if(!graph['trashed'])throw new ServiceError('CONFLICT','只有回收站工作图可彻底删除。');
      if(graph['execution_revision']!==request.expectedExecutionRevision||graph['layout_revision']!==request.expectedLayoutRevision)throw new ServiceError('REVISION_CONFLICT','工作图版本已变化。');
      if(graph['title']!==request.confirmTitle)throw new ServiceError('CONFLICT','确认名称与工作图不符。');
      if(this.db.prepare("SELECT 1 FROM resource_maintenance_leases WHERE kind='backup'").get())throw new ServiceError('MAINTENANCE','备份进行中，请稍后重试。');
      const id=request.graphId;
      this.history.clear(id);
      this.db.prepare('INSERT INTO run_file_deletions(run_id) SELECT id FROM runs WHERE graph_id=?').run(id);
      const hashes=this.db.prepare('SELECT DISTINCT v.sha256 FROM canvas_resource_versions v JOIN canvas_resources r ON r.id=v.resource_id WHERE r.graph_id=?').all(id).map(row=>String(row['sha256']));
      // Keep request hashes as non-replayable tombstones: retries cannot recreate
      // a deleted graph or disclose old snapshots through cached responses.
      this.db.prepare(`UPDATE idempotency SET response='null',invalidated=1 WHERE
        json_extract(response,'$.graphId')=? OR json_extract(response,'$.resource.graphId')=?
        OR json_extract(response,'$.runId') IN (SELECT id FROM runs WHERE graph_id=?)
        OR json_extract(response,'$.id') IN (SELECT id FROM runs WHERE graph_id=?)
        OR EXISTS(SELECT 1 FROM json_each(response,'$.runIds') j WHERE j.value IN (SELECT id FROM runs WHERE graph_id=?))`).run(id,id,id,id,id);
      this.db.prepare('DELETE FROM asset_references WHERE run_id IN (SELECT id FROM runs WHERE graph_id=?) OR node_id IN (SELECT id FROM nodes WHERE graph_id=?)').run(id,id);
      this.db.prepare('DELETE FROM canvas_resource_references WHERE graph_id=?').run(id);
      this.db.prepare('DELETE FROM node_resource_history WHERE node_id IN (SELECT id FROM nodes WHERE graph_id=?)').run(id);
      this.db.prepare('DELETE FROM group_members WHERE group_id IN (SELECT id FROM graph_groups WHERE graph_id=?) OR node_id IN (SELECT id FROM nodes WHERE graph_id=?)').run(id,id);
      this.db.prepare('DELETE FROM graph_groups WHERE graph_id=?').run(id);
      for(const table of ['outputs','canvas_outputs','interactions','occupancy','execution_input_snapshots','snapshots','run_runtime','run_process_records','generation_candidates','publication_manifests'])
        this.db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE graph_id=?)`).run(id);
      this.db.prepare('DELETE FROM runs WHERE graph_id=?').run(id);
      this.db.prepare('DELETE FROM edges WHERE graph_id=?').run(id);
      this.db.prepare('DELETE FROM node_versions WHERE node_id IN (SELECT id FROM nodes WHERE graph_id=?)').run(id);
      this.db.prepare('DELETE FROM nodes WHERE graph_id=?').run(id);
      resources.collectGarbage({graphId:id,blobHashes:hashes});
      if(this.db.prepare('SELECT 1 FROM canvas_resources WHERE graph_id=?').get(id))throw new ServiceError('CONFLICT','仍有外部历史引用，不能清理工作图资源。');
      this.db.prepare('DELETE FROM events WHERE graph_id=?').run(id);
      this.db.prepare('DELETE FROM graphs WHERE id=?').run(id);
      this.repo.appendEvent({eventId:randomUUID(),type:'graph.changed',projectId:request.projectId,graphId:null,entityId:id,revision:Number(graph['execution_revision'])+1,occurredAt:new Date().toISOString(),payload:{graphId:id,deleted:true}});
      return {graphId:id,deleted:true};
    }) as {graphId:string;deleted:true};
  }
  /** Submit owns the transaction; retirement never edits frozen snapshots or Run files. */
  executionOutputs(scope: GraphScope, executionNodeId: string): Node[] {
    this.scope(scope);
    const snapshot = this.snapshot(scope);
    const nodes = new Map([...snapshot.nodes, ...(snapshot.hiddenExecutionOutputs ?? []).map(output => output.node)].map(node => [node.id, node]));
    return this.db.prepare('SELECT n.id FROM execution_outputs o JOIN nodes n ON n.id=o.node_id WHERE o.execution_node_id=? AND n.graph_id=? ORDER BY n.created_at,n.creation_order').all(executionNodeId,scope.graphId).map(row => nodes.get(String(row['id']))!);
  }
  /** Immutable history copies retain successor links, but are never current outputs. */
  assertOutputPreservation(scope: GraphScope, executionNodeId: string, prepared: Node[]): void {
    if (!this.db.isTransaction) throw new Error('Output preservation requires a transaction');
    const outputs = this.executionOutputs(scope, executionNodeId);
    if (canonicalJson(outputs as unknown as Json) !== canonicalJson(prepared as unknown as Json)) throw new ServiceError('REVISION_CONFLICT', 'Outputs changed while preserving history');
    for (const output of outputs) {
      this.assertNodeEditable(output.id);
      for (const edge of this.db.prepare('SELECT target_id FROM edges WHERE source_id=?').all(output.id)) this.assertNodeEditable(String(edge['target_id']));
    }
  }
  retireExecutionOutputs(scope:GraphScope,executionNodeId:string):void {
    if(!this.db.isTransaction)throw new Error('Output retirement requires a transaction');
    const outputs=this.db.prepare('SELECT o.node_id FROM execution_outputs o JOIN nodes n ON n.id=o.node_id WHERE o.execution_node_id=? AND n.graph_id=?').all(executionNodeId,scope.graphId);
    for(const row of outputs){
      const id=String(row['node_id']);this.assertNodeEditable(id);
      for(const edge of this.db.prepare('SELECT target_id FROM edges WHERE source_id=?').all(id))this.assertNodeEditable(String(edge['target_id']));
    }
    for(const row of outputs){
      const id=String(row['node_id']);
      this.db.prepare('DELETE FROM edges WHERE source_id=? OR target_id=?').run(id,id);
      this.db.prepare('DELETE FROM group_members WHERE node_id=?').run(id);
      this.db.prepare("DELETE FROM canvas_resource_references WHERE owner_kind='node' AND node_id=?").run(id);
      this.db.prepare('UPDATE nodes SET deleted=1,undo_expires_at=NULL WHERE id=?').run(id);
    }
    this.db.prepare('DELETE FROM execution_outputs WHERE execution_node_id=?').run(executionNodeId);
    if(outputs.length){
      this.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1,layout_revision=layout_revision+1 WHERE id=?').run(scope.graphId);
      this.event(scope);
    }
  }
  private restoreOutput(scope:GraphScope,op:Extract<GraphCommand['operations'][number],{type:'execution.output.restore'}>):void {
    identifier(op.executionNodeId);identifier(op.nodeId);position(op.x);position(op.y);
    const owner=this.node(scope,op.executionNodeId);this.assertNodeEditable(op.executionNodeId);
    if(owner['type']!=='execution'||!this.db.prepare('SELECT 1 FROM execution_outputs o JOIN nodes n ON n.id=o.node_id WHERE o.node_id=? AND o.execution_node_id=? AND n.graph_id=? AND n.deleted=1').get(op.nodeId,op.executionNodeId,scope.graphId))throw new ServiceError('NOT_FOUND','当前批次中没有该隐藏输出。');
    this.db.prepare('UPDATE nodes SET deleted=0,x=?,y=?,undo_expires_at=NULL WHERE id=?').run(op.x,op.y,op.nodeId);
    const node=this.node(scope,op.nodeId);
    const content=JSON.parse(String(this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(op.nodeId,Number(node['current_version']))!['content'])) as Json;
    this.retainResources(scope,op.nodeId,Number(node['current_version']),content);
    const edge={id:randomUUID(),sourceId:op.executionNodeId,targetId:op.nodeId,kind:'delivery' as const};
    this.validateEdge(scope,edge,true);
    this.db.prepare('INSERT INTO edges(id,graph_id,source_id,target_id,kind) VALUES(?,?,?,?,?)').run(edge.id,scope.graphId,edge.sourceId,edge.targetId,edge.kind);
  }
  assertNodeEditable(nodeId:string):void {if(this.activeNode(nodeId))throw new ServiceError('NODE_LOCKED','执行或生成尚未结束，节点输入已锁定。');}
  private assertContentEditable(node:Record<string,unknown>,content:Json):void {
    if(!this.activeNode(String(node['id'])))return;
    const old=JSON.parse(String(this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(String(node['id']),Number(node['current_version']))!['content'])) as Json;
    if(node['type']==='execution'){
      if(!old||typeof old!=='object'||Array.isArray(old)||!content||typeof content!=='object'||Array.isArray(content)||!Object.hasOwn(content,'title'))throw new ServiceError('NODE_LOCKED','执行期间仅可修改节点名称。');
      title(content['title']);
      const withoutTitle=(value:Record<string,Json>):Json=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='title')) as Json;
      if(canonicalJson(withoutTitle(old))!==canonicalJson(withoutTitle(content)))throw new ServiceError('NODE_LOCKED','执行期间仅可修改节点名称。');
      return;
    }
    const prompt=(value:Json):Json=>value&&typeof value==='object'&&!Array.isArray(value)?value['prompt']??null:null;
    if(canonicalJson(prompt(old))!==canonicalJson(prompt(content)))throw new ServiceError('NODE_LOCKED','生成期间提示词已锁定，正文仍可编辑。');
  }
  private validateContent(node:Record<string,unknown>,content:Json):void {
    if(content&&typeof content==='object'&&!Array.isArray(content)&&content['source']!==undefined){
      const source=content['source'];
      if(!source||typeof source!=='object'||Array.isArray(source)||typeof source['relativePath']!=='string')throw new ServiceError('INVALID_REQUEST','项目文件来源无效。');
      if(source['kind']==='project-file') {
        if(source['serviceId']!==this.serviceId||typeof source['projectId']!=='string'||!source['relativePath'])throw new ServiceError('INVALID_REQUEST','项目文件来源无效。');
        const project=this.db.prepare('SELECT g.project_id FROM graphs g JOIN nodes n ON n.graph_id=g.id WHERE n.id=?').get(String(node['id']));
        if(!project||source['projectId']!==project['project_id'])throw new ServiceError('INVALID_REQUEST','项目文件引用不属于当前项目。');
      } else if(source['kind']!=='project-file-empty'||Object.keys(source).some(key=>!['kind','relativePath'].includes(key))) throw new ServiceError('INVALID_REQUEST','空引用来源无效。');
      if(content['resourceId']!==undefined||content['resourceVersion']!==undefined)throw new ServiceError('INVALID_REQUEST','项目文件来源与工作图资源来源必须互斥。');
    }
    const state=new PluginRegistry(this.db).inspect(String(node['type']),Number(node['schema_version']),content).state;
    if(state!=='available')throw new ServiceError(state==='invalid'?'INVALID_REQUEST':'PLUGIN_UNAVAILABLE','节点正文或插件资源契约不可用。');
  }
  private node(scope:GraphScope,id:string):Record<string,unknown>{const row=this.db.prepare('SELECT * FROM nodes WHERE id=? AND graph_id=? AND deleted=0').get(id,scope.graphId);if(!row)throw new ServiceError('NOT_FOUND','节点不存在。');return row;}
  private group(scope:GraphScope,id:string):Record<string,unknown>{
    identifier(id);
    const node=this.node(scope,id);
    if(node['type']!=='group'||!this.db.prepare('SELECT 1 FROM graph_groups WHERE id=? AND graph_id=? AND run_id IS NULL').get(id,scope.graphId))throw new ServiceError('INVALID_REQUEST','仅支持画布分组节点。');
    return node;
  }
  private members(scope:GraphScope,id:string):string[]{this.group(scope,id);return this.db.prepare('SELECT m.node_id FROM group_members m JOIN nodes n ON n.id=m.node_id WHERE m.group_id=? AND n.graph_id=? AND n.deleted=0 ORDER BY n.created_at,n.creation_order').all(id,scope.graphId).map(row=>String(row['node_id']));}
  private assertLayoutEditable(scope:GraphScope,id:string):void{
    const node=this.node(scope,id);this.assertNodeEditable(id);
    if(node['type']==='group')for(const member of this.members(scope,id))this.assertNodeEditable(member);
  }
  private assertGeometryEditable(scope:GraphScope,id:string):Record<string,unknown>{
    const node=this.node(scope,id);
    if(node['type']==='group')this.group(scope,id);
    return node;
  }
  /** Membership is layout metadata, never a node content/resource revision. */
  setGroupMembers(scope:GraphScope,groupId:string,memberIds:string[]):void{
    if(!this.db.isTransaction)throw new Error('Group membership requires the graph transaction');
    this.writable(scope);this.group(scope,groupId);
    if(!Array.isArray(memberIds)||memberIds.some(id=>typeof id!=='string')||new Set(memberIds).size!==memberIds.length)throw new ServiceError('INVALID_REQUEST','分组成员必须是无重复的节点 ID 数组。');
    for(const id of memberIds){
      identifier(id);const member=this.node(scope,id);
      if(member['type']==='group')throw new ServiceError('INVALID_REQUEST','不支持嵌套分组。');
      if(this.db.prepare("SELECT 1 FROM group_members m JOIN graph_groups g ON g.id=m.group_id JOIN nodes n ON n.id=g.id AND n.graph_id=g.graph_id WHERE m.node_id=? AND m.group_id!=? AND g.run_id IS NULL AND n.type='group' AND n.deleted=0").get(id,groupId))throw new ServiceError('CONFLICT','节点已属于其他画布分组。');
    }
    this.db.prepare('DELETE FROM group_members WHERE group_id=?').run(groupId);
    for(const id of memberIds)this.db.prepare('INSERT INTO group_members(group_id,node_id) VALUES(?,?)').run(groupId,id);
  }
  private move(scope:GraphScope,positions:{nodeId:string;x:number;y:number}[]):void{
    if(!Array.isArray(positions)||positions.length>1000)throw new ServiceError('INVALID_REQUEST','无效布局。');
    const moves=new Map<string,{x:number;y:number}>(),groups:{id:string;x:number;y:number;dx:number;dy:number}[]=[];
    for(const point of positions){
      if(!point||typeof point!=='object')throw new ServiceError('INVALID_REQUEST','无效布局点。');
      identifier(point.nodeId);
      if(moves.has(point.nodeId))throw new ServiceError('INVALID_REQUEST','重复移动节点。');
      const node=this.assertGeometryEditable(scope,point.nodeId);position(point.x);position(point.y);
      moves.set(point.nodeId,{x:point.x,y:point.y});
      if(node['type']==='group')groups.push({id:point.nodeId,x:point.x,y:point.y,dx:point.x-Number(node['x']),dy:point.y-Number(node['y'])});
    }
    // As in the original canvas, an explicitly moved group owns its members'
    // translation; selecting both the frame and a member never moves it twice.
    for(const group of groups)for(const id of this.members(scope,group.id)){
      const node=this.node(scope,id),x=Number(node['x'])+group.dx,y=Number(node['y'])+group.dy;position(x);position(y);moves.set(id,{x,y});
    }
    for(const [id,point] of moves)this.db.prepare('UPDATE nodes SET x=?,y=? WHERE id=?').run(point.x,point.y,id);
  }
  private resize(scope:GraphScope,sizes:Extract<GraphCommand['operations'][number],{type:'layout.resize'}>['sizes']):void{
    if(!Array.isArray(sizes)||sizes.length>1000)throw new ServiceError('INVALID_REQUEST','无效尺寸列表。');const ids=new Set<string>();
    for(const size of sizes){
      if(!size||typeof size!=='object'||ids.has(size.nodeId))throw new ServiceError('INVALID_REQUEST','无效或重复尺寸节点。');ids.add(size.nodeId);
      identifier(size.nodeId);
      const node=this.assertGeometryEditable(scope,size.nodeId);
      if(size.width!==null)nodeDimension(size.width);if(size.height!==null)nodeDimension(size.height);
      if(size.x!==undefined)position(size.x);if(size.y!==undefined)position(size.y);
      this.db.prepare('UPDATE nodes SET width=?,height=?,x=?,y=? WHERE id=?').run(size.width,size.height,size.x??Number(node['x']),size.y??Number(node['y']),size.nodeId);
    }
  }
  /** All retained node content versions protect resources independently of live node references. */
  retainResources(scope:GraphScope,nodeId:string,version:number,content:Json):void {
    this.db.prepare("DELETE FROM canvas_resource_references WHERE owner_kind='node' AND node_id=?").run(nodeId);
    for(const link of resourceLinks(content)){
      if(!this.db.prepare('SELECT 1 FROM canvas_resources r JOIN canvas_resource_versions v ON v.resource_id=r.id WHERE r.id=? AND r.graph_id=? AND v.version=?').get(link.resourceId,scope.graphId,link.version))throw new ServiceError('INPUT_BLOCKED','资源不属于本图或版本不存在。');
      this.db.prepare('INSERT OR IGNORE INTO node_resource_history(node_id,node_version,resource_id,resource_version) VALUES(?,?,?,?)').run(nodeId,version,link.resourceId,link.version);
      this.db.prepare("INSERT INTO canvas_resource_references(id,resource_id,resource_version,graph_id,owner_kind,node_id) VALUES(?,?,?,?,'node',?)").run(randomUUID(),link.resourceId,link.version,scope.graphId,nodeId);
      this.db.prepare("DELETE FROM canvas_resource_references WHERE graph_id=? AND resource_id=? AND resource_version=? AND owner_kind='graph'").run(scope.graphId,link.resourceId,link.version);
    }
  }
  private validateFileNode(scope:GraphScope,content:Json):void {
    if(!content||typeof content!=='object'||Array.isArray(content))throw new ServiceError('INVALID_REQUEST','文件节点正文无效。');
    const data=content as Record<string,Json>;
    const source=data.source;
    if(source!==undefined){
      if(data.resourceId!==undefined||data.resourceVersion!==undefined)throw new ServiceError('INVALID_REQUEST','项目文件来源与工作图资源来源必须互斥。');
      if(!source||typeof source!=='object'||Array.isArray(source)||typeof source.relativePath!=='string')throw new ServiceError('INVALID_REQUEST','项目文件来源无效或不属于当前项目。');
      if(source.kind==='project-file-empty') { if(Object.keys(source).some(key=>!['kind','relativePath'].includes(key)))throw new ServiceError('INVALID_REQUEST','空引用来源无效。'); return; }
      if(source.kind!=='project-file'||source.serviceId!==this.serviceId||source.projectId!==scope.projectId||!source.relativePath)throw new ServiceError('INVALID_REQUEST','项目文件来源无效或不属于当前项目。');
      return;
    }
    if(data.resourceId===undefined&&data.resourceVersion===undefined)return;
    if(typeof data.resourceId!=='string'||!Number.isSafeInteger(data.resourceVersion)||Number(data.resourceVersion)<1)throw new ServiceError('INVALID_REQUEST','文件节点资源版本无效。');
    const row=this.db.prepare('SELECT b.bytes FROM canvas_resources r JOIN canvas_resource_versions v ON v.resource_id=r.id JOIN blobs b ON b.sha256=v.sha256 WHERE r.id=? AND r.graph_id=? AND v.version=?').get(data.resourceId as string,scope.graphId,Number(data.resourceVersion));
    if(!row)throw new ServiceError('INPUT_BLOCKED','文件节点资源不存在。');
    const bytes=Number(row['bytes']);
    if(bytes>WORKGRAPH_UPLOAD_MAX_BYTES)throw new ServiceError('PAYLOAD_TOO_LARGE','文件节点最大支持 300 MB。');
    if(data.bytes!==undefined&&(!Number.isSafeInteger(data.bytes)||Number(data.bytes)<0||Number(data.bytes)!==bytes))throw new ServiceError('INVALID_REQUEST','文件节点资源大小无效。');
  }
  /** Trusted publication/import only. Public commands cannot create delivery edges/read-only nodes. */
  insertNode(scope:GraphScope,node:Node,trusted=false):void {
    node={...node,content:limitNodeContentTitle(node.content)};
    identifier(node.id);if(typeof node.type!=='string'||!node.type||node.type.length>128||!Number.isSafeInteger(node.schemaVersion)||node.schemaVersion<1||node.contentVersion!==1)throw new ServiceError('INVALID_REQUEST','节点类型或版本无效。');
    if(node.readOnly&&!trusted)throw new ServiceError('INVALID_REQUEST','客户端不能伪造服务只读产出。');position(node.x);position(node.y);boundedContent(node.content);
    if(node.width!==undefined)nodeDimension(node.width);if(node.height!==undefined)nodeDimension(node.height);
    if(node.type!=='group'&&node.memberIds!==undefined)throw new ServiceError('INVALID_REQUEST','仅分组可携带 memberIds。');
    if(this.db.prepare('SELECT 1 FROM nodes WHERE id=?').get(node.id))throw new ServiceError('CONFLICT','节点标识已存在。');
    if(node.type==='group'&&this.db.prepare('SELECT 1 FROM graph_groups WHERE id=?').get(node.id))throw new ServiceError('CONFLICT','分组标识已存在。');
    const plugin=new PluginRegistry(this.db).inspect(node.type,node.schemaVersion,node.content);
    if(node.content&&typeof node.content==='object'&&!Array.isArray(node.content)){const source=node.content['source'];if(source&&typeof source==='object'&&!Array.isArray(source)&&source['kind']==='project-file'&&source['projectId']!==scope.projectId)throw new ServiceError('INVALID_REQUEST','项目文件引用不属于当前项目。');}
    if(node.type==='file'&&node.schemaVersion===1)this.validateFileNode(scope,node.content);
    if(node.type==='group'&&(plugin.state!=='available'||node.readOnly))throw new ServiceError('INVALID_REQUEST','分组必须使用内置 schema 1，仅允许标题和布局。');
    if(plugin.state==='invalid'&&!trusted)throw new ServiceError('INVALID_REQUEST','节点正文不符合资源契约。');
    const known=plugin.state==='available';
    const reason=node.readOnly?'original':!known?'missing_plugin':'none';
    this.db.prepare('INSERT INTO nodes(id,graph_id,type,schema_version,current_version,x,y,read_only,read_only_reason,created_at,creation_order) VALUES(?,?,?,?,1,?,?,?,?,?,(SELECT COALESCE(MAX(creation_order),0)+1 FROM nodes))').run(node.id,scope.graphId,node.type,node.schemaVersion,node.x,node.y,Number(node.readOnly||!known),reason,Date.now());
    this.db.prepare('UPDATE nodes SET width=?,height=? WHERE id=?').run(node.width??null,node.height??null,node.id);
    this.db.prepare('INSERT INTO node_versions(node_id,version,content) VALUES(?,1,?)').run(node.id,canonicalJson(node.content));this.retainResources(scope,node.id,1,node.content);
    if(node.type==='group'){
      const name=(node.content as Record<string,Json>)['title']??'分组';title(name);
      this.db.prepare('INSERT INTO graph_groups(id,graph_id,run_id,title) VALUES(?,?,NULL,?)').run(node.id,scope.graphId,name);
      this.setGroupMembers(scope,node.id,node.memberIds??[]);
    }
  }
  validateEdge(scope:GraphScope,edge:Edge,trusted=false):void {
    identifier(edge.id);if(!['reference','execution','delivery'].includes(edge.kind)||edge.sourceId===edge.targetId)throw new ServiceError('INVALID_EDGE','无效连线。');
    identifier(edge.sourceId);identifier(edge.targetId);
    if(this.db.prepare('SELECT 1 FROM edges WHERE id=? OR (graph_id=? AND source_id=? AND target_id=?)').get(edge.id,scope.graphId,edge.sourceId,edge.targetId))throw new ServiceError('CONFLICT','连线已存在。');
    const source=this.node(scope,edge.sourceId),target=this.node(scope,edge.targetId);
    if(source['type']==='group'||target['type']==='group')throw new ServiceError('INVALID_EDGE','纯布局分组不能作为依赖边端点。');
    if(edge.kind==='delivery'){if(!trusted||source['type']!=='execution'||!target['read_only']||['execution','group','preview'].includes(String(target['type'])))throw new ServiceError('INVALID_EDGE','交付边只能由服务发布。');return;}
    if(edge.kind==='execution'){
      if(source['type']!=='execution'||target['type']!=='execution')throw new ServiceError('INVALID_EDGE','串联边只能连接执行节点。');
      const dependencies=this.db.prepare("SELECT source_id,target_id FROM edges WHERE graph_id=? AND kind='execution'").all(scope.graphId).map(row=>({sourceId:String(row['source_id']),targetId:String(row['target_id']),kind:'execution'}));
      if(!executionOrder([...dependencies,edge]))throw new ServiceError('INVALID_EDGE','不能创建串联连线：该连接会形成环。');
      this.assertNodeEditable(edge.targetId);return;
    }
    const previewError=previewEdgeError(String(source['type']),String(target['type']),Number(this.db.prepare('SELECT COUNT(*) AS n FROM edges WHERE target_id=?').get(edge.targetId)!['n']));
    if(previewError)throw new ServiceError('INVALID_EDGE',previewError);
    if(source['type']==='execution')throw new ServiceError('INVALID_EDGE','执行节点不能作为内容前驱，请连接输出产物。');
    if(['execution','text','image','document','video','file'].includes(String(target['type']))||!BUILTINS.has(String(target['type']))){const count=Number(this.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE target_id=? AND kind='reference'").get(edge.targetId)!['n']);if(count>=8)throw new ServiceError('INVALID_EDGE','直接前驱最多 8 个。');}
    // Input topology is frozen for both execution and generation. Generation
    // body edits remain allowed and publish through the candidate CAS mechanism.
    this.assertNodeEditable(edge.targetId);
  }
  command(command:GraphCommand,principal='local'):GraphSnapshot {
    if(!Array.isArray(command.operations)||!command.operations.length||command.operations.length>1000)throw new ServiceError('INVALID_REQUEST','命令需要 1～1000 个操作。');
    for(const op of command.operations){
      if(!op||typeof op!=='object'||typeof op.type!=='string')throw new ServiceError('INVALID_REQUEST','无效图操作。');
      if(op.type==='node.create'&&(!op.node||typeof op.node!=='object'))throw new ServiceError('INVALID_REQUEST','缺少节点。');
      if(op.type==='node.project-file.associate'&&(!['text','image','file'].includes(op.nodeType)||!Number.isSafeInteger(op.expectedContentVersion)))throw new ServiceError('INVALID_REQUEST','空引用关联参数无效。');
      if(op.type==='node.delete'&&op.retainResourcesForUndo!==undefined&&typeof op.retainResourcesForUndo!=='boolean')throw new ServiceError('INVALID_REQUEST','撤销资源保留标记必须是布尔值。');
      if(op.type==='edge.create'&&(!op.edge||typeof op.edge!=='object'))throw new ServiceError('INVALID_REQUEST','缺少连线。');
      if(op.type==='layout.move'&&Array.isArray(op.positions)&&op.positions.some(point=>!point||typeof point!=='object'))throw new ServiceError('INVALID_REQUEST','无效布局点。');
    }
    const lifecycle=command.operations.some(op=>['graph.archive','graph.trash'].includes(op.type));
    if(lifecycle&&command.operations.length!==1)throw new ServiceError('INVALID_REQUEST','生命周期转换必须单独提交。');
    return this.repo.idempotent(principal+':graph.command:'+command.graphId,command.idempotencyKey,command as unknown as Json,()=>{
      command={...command,operations:limitNodeTitleOperations(command.operations)};
      const graph=lifecycle?this.scope(command):this.writable(command);
      const historyBefore=this.history.capture(command);
      if(lifecycle)assertProjectWritable(this.db,command.projectId);
      if(command.operations.some(op=>op.type==='node.delete'||op.type==='edge.create'||op.type==='edge.delete'))this.assertChainTopologyEditable(command,command.operations);
      const types=new Map(this.db.prepare('SELECT id,type FROM nodes WHERE graph_id=? AND deleted=0').all(command.graphId).map(row=>[String(row['id']),String(row['type'])]));
      for(const op of command.operations)if(op.type==='node.create')types.set(op.node.id,op.node.type);
      const layoutOnly=(op:GraphCommand['operations'][number]):boolean=>['layout.move','layout.resize','group.members','group.rename','graph.rename'].includes(op.type)||(op.type==='node.create'&&op.node.type==='group')||(op.type==='node.delete'&&types.get(op.nodeId)==='group');
      const execution=command.operations.some(op=>!layoutOnly(op));
      const layout=command.operations.some(op=>layoutOnly(op)||op.type==='node.create'||op.type==='node.delete'||op.type==='execution.output.restore');
      if((execution&&graph['execution_revision']!==command.expectedExecutionRevision)||(layout&&graph['layout_revision']!==command.expectedLayoutRevision))throw new ServiceError('REVISION_CONFLICT','工作图版本已变化，请读取最新快照。');
      // The entire command is atomic: delivery documents may be deleted before or
      // after their execution node, but every remaining hard target must be included.
      const deleting=new Set(command.operations.flatMap(op=>op.type==='node.delete'?[op.nodeId]:[]));
      for(const op of command.operations){
        if(op.type==='node.content'){const target=this.node(command,op.nodeId);if(target['type']==='group')throw new ServiceError('INVALID_REQUEST','分组无正文，请使用 group.rename 或布局命令。');this.assertContentEditable(target,op.content);if(!target['read_only'])this.validateContent(target,op.content);if(target['type']==='file')this.validateFileNode(command,op.content);}
        if(op.type==='node.project-file.associate'){
          const target=this.node(command,op.nodeId);
          const old=JSON.parse(String(this.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(op.nodeId,Number(target['current_version']))!['content'])) as Json;
          const oldSource=old&&typeof old==='object'&&!Array.isArray(old)?old['source']:null;
          const nextSource=op.content&&typeof op.content==='object'&&!Array.isArray(op.content)?op.content['source']:null;
          if(target['read_only']||!oldSource||typeof oldSource!=='object'||Array.isArray(oldSource)||!nextSource||typeof nextSource!=='object'||Array.isArray(nextSource))throw new ServiceError('INVALID_REQUEST','项目文件引用转换无效。');
          const oldKind=oldSource['kind'],nextKind=nextSource['kind'];
          if(!((oldKind==='project-file-empty'&&nextKind==='project-file')||(oldKind==='project-file'&&nextKind==='project-file-empty')))throw new ServiceError('INVALID_REQUEST','项目文件引用只能在空引用和已关联状态之间转换。');
          this.assertNodeEditable(op.nodeId);
          this.validateContent({...target,type:op.nodeType,schema_version:1},op.content);
          if(op.nodeType==='file')this.validateFileNode(command,op.content);
        }
        switch(op.type){
        case 'execution.output.restore':this.restoreOutput(command,op);break;
        case 'node.create':this.insertNode(command,op.node);break;
        case 'node.content':{const node=this.node(command,op.nodeId);if(node['read_only'])throw new ServiceError('NODE_LOCKED','原始交付或未知插件节点只读，请独立复制后编辑。');if(node['current_version']!==op.expectedContentVersion)throw new ServiceError('REVISION_CONFLICT','节点正文已变化。');boundedContent(op.content);const version=op.expectedContentVersion+1;this.db.prepare('INSERT INTO node_versions(node_id,version,content) VALUES(?,?,?)').run(op.nodeId,version,canonicalJson(op.content));this.db.prepare('UPDATE nodes SET current_version=? WHERE id=?').run(version,op.nodeId);this.retainResources(command,op.nodeId,version,op.content);break;}
        case 'node.project-file.associate':{const node=this.node(command,op.nodeId);if(node['current_version']!==op.expectedContentVersion)throw new ServiceError('REVISION_CONFLICT','空引用节点已变化。');boundedContent(op.content);const version=op.expectedContentVersion+1;this.db.prepare('INSERT INTO node_versions(node_id,version,content) VALUES(?,?,?)').run(op.nodeId,version,canonicalJson(op.content));this.db.prepare('UPDATE nodes SET type=?,schema_version=1,current_version=? WHERE id=?').run(op.nodeType,version,op.nodeId);this.retainResources(command,op.nodeId,version,op.content);break;}
        case 'node.delete':{const target=this.node(command,op.nodeId);const output=this.db.prepare('SELECT execution_node_id FROM execution_outputs WHERE node_id=?').get(op.nodeId);if(target['type']==='group')this.group(command,op.nodeId);else this.assertLayoutEditable(command,op.nodeId);for(const edge of this.db.prepare('SELECT target_id FROM edges WHERE source_id=?').all(op.nodeId)){this.assertNodeEditable(String(edge['target_id']));}
          if(this.db.prepare("SELECT target_id FROM edges WHERE source_id=? AND kind='delivery'").all(op.nodeId).some(edge=>!deleting.has(String(edge['target_id']))))throw new ServiceError('INVALID_EDGE','请先隐藏或同时删除此执行节点的全部输出产物。');
          if(target['type']==='group'){this.db.prepare('DELETE FROM group_members WHERE group_id=?').run(op.nodeId);this.db.prepare('DELETE FROM graph_groups WHERE id=? AND graph_id=? AND run_id IS NULL').run(op.nodeId,command.graphId);}
          this.db.prepare('DELETE FROM edges WHERE source_id=? OR target_id=?').run(op.nodeId,op.nodeId);this.db.prepare('DELETE FROM group_members WHERE node_id=?').run(op.nodeId);
          this.db.prepare("DELETE FROM canvas_resource_references WHERE owner_kind='node' AND node_id=?").run(op.nodeId);
          // Browser history owns no file bytes. Keep exact versions for its
          // bounded undo window; normal deletion retains immediate GC behavior.
          const undoExpiresAt=op.retainResourcesForUndo&&!target['read_only']?Date.now()+24*60*60*1000:null;
          if(undoExpiresAt===null&&!output)this.db.prepare('DELETE FROM node_resource_history WHERE node_id=?').run(op.nodeId);
          this.db.prepare('UPDATE nodes SET deleted=1,undo_expires_at=? WHERE id=?').run(undoExpiresAt,op.nodeId);
          if(target['type']==='execution')this.db.prepare('DELETE FROM execution_outputs WHERE execution_node_id=?').run(op.nodeId);break;}
        case 'edge.create':this.validateEdge(command,op.edge);this.db.prepare('INSERT INTO edges(id,graph_id,source_id,target_id,kind) VALUES(?,?,?,?,?)').run(op.edge.id,command.graphId,op.edge.sourceId,op.edge.targetId,op.edge.kind);break;
        case 'edge.delete':{const edge=this.db.prepare('SELECT * FROM edges WHERE id=? AND graph_id=?').get(op.edgeId,command.graphId);if(!edge)throw new ServiceError('NOT_FOUND','连线不存在。');if(edge['kind']==='delivery'&&!deleting.has(String(edge['target_id'])))throw new ServiceError('INVALID_EDGE','任务到输出产物的连线只能随产物隐藏或删除。');this.assertNodeEditable(String(edge['target_id']));this.db.prepare('DELETE FROM edges WHERE id=?').run(op.edgeId);break;}
        case 'layout.move':this.move(command,op.positions);break;
        case 'layout.resize':this.resize(command,op.sizes);break;
        case 'group.members':this.setGroupMembers(command,op.groupId,op.memberIds);break;
        case 'group.rename':title(op.title);this.group(command,op.groupId);this.db.prepare('UPDATE graph_groups SET title=? WHERE id=? AND graph_id=? AND run_id IS NULL').run(op.title,op.groupId,command.graphId);break;
        case 'graph.rename':title(op.title);this.db.prepare('UPDATE graphs SET title=? WHERE id=?').run(op.title,command.graphId);break;
        case 'graph.archive':case 'graph.trash':this.lifecycle(command,op);break;
        default:throw new ServiceError('INVALID_REQUEST','不支持的图命令。');
      }}
      this.db.prepare('UPDATE graphs SET execution_revision=execution_revision+?,layout_revision=layout_revision+? WHERE id=?').run(Number(execution),Number(layout),command.graphId);this.history.record(command,historyBefore,lifecycle);this.event(command);return this.snapshot(command) as unknown as Json;
    }) as unknown as GraphSnapshot;
  }
}
