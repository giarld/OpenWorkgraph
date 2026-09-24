import type {GraphScope, GraphSnapshot, Json} from '@openworkgraph/protocol';
import {Graphs} from './graphs.js';
import {PluginRegistry, checkedJson} from './plugins.js';
import type {PluginContract} from './plugins.js';
import {atomic} from './persistence/database.js';
import {canonicalJson} from './persistence/repositories.js';
import {ServiceError} from './errors.js';

export interface PluginNodeChange extends GraphScope {
  nodeId:string; expectedExecutionRevision:number; expectedContentVersion:number; expectedSchemaVersion:number; idempotencyKey:string;
}
export interface PluginNodeMigration extends PluginNodeChange {toSchemaVersion:number}
export interface HistoricalPluginNode {nodeId:string;type:string;schemaVersion:number;contentVersion:number;content:Json}
const core=new Set(['text','image','document','video','file','preview','execution']);
/** Local declarative registration and explicit node lifecycle operations only.
 * The HTTP surface MUST NOT expose registerTrustedLocal. Restore/migrate require
 * the caller's authenticated graph scope; both nest in that authorization transaction. */
export class PluginManagement {
  readonly registry:PluginRegistry;
  constructor(readonly graphs:Graphs,registry?:PluginRegistry){this.registry=registry??new PluginRegistry(graphs.db);}
  registerTrustedLocal(manifest:unknown):PluginContract {return atomic(this.graphs.db,()=>this.registry.registerTrusted(manifest));}
  private storage():void {
    if(!this.graphs.db.prepare('PRAGMA table_info(nodes)').all().some(c=>c['name']==='read_only_reason') || !this.graphs.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_version_schemas'").get()) throw new ServiceError('SCHEMA_UNSUPPORTED','Plugin migration requires read_only_reason and node_version_schemas storage');
  }
  private validate(request:PluginNodeChange):void {
    if(typeof request.nodeId!=='string'||!request.nodeId||typeof request.idempotencyKey!=='string'||!request.idempotencyKey)throw new ServiceError('INVALID_REQUEST','Node and idempotency key are required');
    for(const value of [request.expectedContentVersion,request.expectedSchemaVersion])if(!Number.isSafeInteger(value)||value<1)throw new ServiceError('INVALID_REQUEST','Expected positive node/schema version');
    if(!Number.isSafeInteger(request.expectedExecutionRevision)||request.expectedExecutionRevision<0)throw new ServiceError('INVALID_REQUEST','Expected graph execution revision');
  }
  private guardedNode(request:PluginNodeChange):Record<string,unknown> {
    const graph=this.graphs.writable(request);
    if(graph['execution_revision']!==request.expectedExecutionRevision)throw new ServiceError('REVISION_CONFLICT','Graph execution revision changed');
    const node=this.graphs.db.prepare('SELECT n.*,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.deleted=0').get(request.nodeId,request.graphId);
    if(!node)throw new ServiceError('NOT_FOUND','Plugin node not found');
    if(node['current_version']!==request.expectedContentVersion||node['schema_version']!==request.expectedSchemaVersion)throw new ServiceError('REVISION_CONFLICT','Node content/schema version changed');
    this.graphs.assertNodeEditable(request.nodeId);
    if(core.has(String(node['type']))||node['read_only_reason']==='original'||(node['read_only']&&node['read_only_reason']!=='missing_plugin')||this.graphs.db.prepare("SELECT 1 FROM edges WHERE graph_id=? AND target_id=? AND kind='delivery'").get(request.graphId,request.nodeId))throw new ServiceError('NODE_LOCKED','Original delivery or ambiguous read-only node cannot be migrated/unlocked');
    const history=this.graphs.db.prepare('SELECT schema_version FROM node_version_schemas WHERE node_id=? AND version=?').get(request.nodeId,request.expectedContentVersion);
    if(!history||history['schema_version']!==request.expectedSchemaVersion)throw new ServiceError('SCHEMA_UNSUPPORTED','Current node schema history is missing or inconsistent');
    if(this.graphs.db.prepare('SELECT 1 FROM node_versions v LEFT JOIN node_version_schemas s ON s.node_id=v.node_id AND s.version=v.version WHERE v.node_id=? AND s.node_id IS NULL LIMIT 1').get(request.nodeId))throw new ServiceError('SCHEMA_UNSUPPORTED','Retained node versions must all have schema history before migration');
    return node;
  }
  migrateNode(request:PluginNodeMigration,principal='local'):GraphSnapshot {
    this.validate(request);if(!Number.isSafeInteger(request.toSchemaVersion)||request.toSchemaVersion<=request.expectedSchemaVersion)throw new ServiceError('INVALID_REQUEST','Migration requires a newer explicit target schema');
    return atomic(this.graphs.db,()=>{
      this.storage();this.graphs.writable(request);
      return this.graphs.repo.idempotent(principal+':plugin.migrate:'+request.graphId,request.idempotencyKey,request as unknown as Json,()=>{
        const node=this.guardedNode(request);
        const content=checkedJson(this.registry.migrate(String(node['type']),request.expectedSchemaVersion,request.toSchemaVersion,JSON.parse(String(node['content']))));
        let count=0;const visit=(v:Json):void=>{if(++count>100000)throw new ServiceError('PAYLOAD_TOO_LARGE','Migrated content has too many values');if(v&&typeof v==='object')for(const c of Object.values(v))visit(c);};visit(content);
        const version=request.expectedContentVersion+1;
        // Deferrable node version FK permits changing the pointer first. The
        // node_versions INSERT trigger then records the NEW schema, not the old.
        const result=this.graphs.db.prepare("UPDATE nodes SET schema_version=?,current_version=?,read_only=0,read_only_reason='none' WHERE id=? AND graph_id=? AND current_version=? AND schema_version=? AND deleted=0").run(request.toSchemaVersion,version,request.nodeId,request.graphId,request.expectedContentVersion,request.expectedSchemaVersion);
        if(result.changes!==1)throw new ServiceError('REVISION_CONFLICT','Node changed during migration');
        this.graphs.db.prepare('INSERT INTO node_versions(node_id,version,content) VALUES(?,?,?)').run(request.nodeId,version,canonicalJson(content));
        const schema=this.graphs.db.prepare('SELECT schema_version FROM node_version_schemas WHERE node_id=? AND version=?').get(request.nodeId,version);
        if(schema?.['schema_version']!==request.toSchemaVersion)throw new ServiceError('SCHEMA_UNSUPPORTED','Schema history INSERT trigger is missing or inconsistent');
        this.graphs.retainResources(request,request.nodeId,version,content);
        this.graphs.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1 WHERE id=?').run(request.graphId);this.graphs.event(request);
        return this.graphs.snapshot(request) as unknown as Json;
      }) as unknown as GraphSnapshot;
    });
  }
  restoreNode(request:PluginNodeChange,principal='local'):GraphSnapshot {
    this.validate(request);
    return atomic(this.graphs.db,()=>{
      this.storage();this.graphs.writable(request);
      return this.graphs.repo.idempotent(principal+':plugin.restore:'+request.graphId,request.idempotencyKey,request as unknown as Json,()=>{
        const node=this.guardedNode(request);
        if(node['read_only_reason']!=='missing_plugin')throw new ServiceError('NODE_LOCKED','Only a proven missing-plugin placeholder can be restored');
        if(this.registry.inspect(String(node['type']),request.expectedSchemaVersion,JSON.parse(String(node['content']))).state!=='available')throw new ServiceError('PLUGIN_UNAVAILABLE','The exact schema contract is not available or content is invalid');
        this.graphs.db.prepare("UPDATE nodes SET read_only=0,read_only_reason='none' WHERE id=?").run(request.nodeId);
        this.graphs.db.prepare('UPDATE graphs SET execution_revision=execution_revision+1 WHERE id=?').run(request.graphId);this.graphs.event(request);
        return this.graphs.snapshot(request) as unknown as Json;
      }) as unknown as GraphSnapshot;
    });
  }
  readVersion(scope:GraphScope,nodeId:string,version:number):HistoricalPluginNode {
    this.storage();this.graphs.scope(scope);
    if(!Number.isSafeInteger(version)||version<1)throw new ServiceError('INVALID_REQUEST','Invalid content version');
    const row=this.graphs.db.prepare('SELECT n.type,v.content,s.schema_version FROM nodes n JOIN node_versions v ON v.node_id=n.id JOIN node_version_schemas s ON s.node_id=v.node_id AND s.version=v.version WHERE n.id=? AND n.graph_id=? AND v.version=?').get(nodeId,scope.graphId,version);
    if(!row)throw new ServiceError('NOT_FOUND','Node version/schema history not found');
    return {nodeId,type:String(row['type']),schemaVersion:Number(row['schema_version']),contentVersion:version,content:JSON.parse(String(row['content'])) as Json};
  }
}
