import { createHash, randomUUID } from 'node:crypto';
import { executionOrder, isTerminalRunStatus, type ExecutionPlan, type GraphSnapshot, type Json, type Run, type SubmitRun } from '@openworkgraph/protocol';
import { Runs } from './runs.js';
import { Graphs } from './graphs.js';
import { Resources } from './resources.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';

/** Accepted runs are durable submissions. Only confirmed, dependency-ready runs enter the queue. */
export class ExecutionChains {
  private pumping = false;
  private stopped = false;
  stop() { this.stopped = true; }
  constructor(readonly runs: Runs, readonly graphs: Graphs, readonly resources: Resources) {}
  private get db() { return this.runs.db; }
  private histories(graph: GraphSnapshot, nodeId: string, exclude?: string) {
    return this.db.prepare('SELECT id FROM runs WHERE project_id=? AND graph_id=? AND node_id=? ORDER BY sequence').all(graph.projectId,graph.graphId,nodeId).filter(row=>row.id!==exclude).map(row=>this.runs.get(String(row.id)));
  }
  plan(graph: GraphSnapshot, targetId: string, exclude?: string): ExecutionPlan {
    const edges = graph.edges.filter(e => e.kind === 'execution');
    if (!executionOrder(edges)) throw new ServiceError('INVALID_EDGE', '执行依赖存在环。');
    if (graph.nodes.find(n => n.id === targetId)?.type !== 'execution') throw new ServiceError('INVALID_REQUEST', '只有执行节点支持串联调度。');
    const ids = new Set([targetId]), queue = [targetId];
    for (let i = 0; i < queue.length; i++) for (const e of edges) if (e.targetId === queue[i] && !ids.has(e.sourceId)) { ids.add(e.sourceId); queue.push(e.sourceId); }
    const nodes = graph.nodes.filter(n => ids.has(n.id)).map(n => {
      const history = this.histories(graph, n.id, exclude);
      const content = n.content && typeof n.content === 'object' && !Array.isArray(n.content) ? n.content : {};
      // Already submitted runs use their frozen prompt, not subsequent node edits.
      const submitted = n.id === targetId && exclude || history.find(r => r.status === 'accepted' && ['manual','confirm'].includes(r.executionStart ?? ''))?.id;
      const prompt = submitted ? this.runs.snapshot(submitted).prompt : content.prompt;
      return { id:n.id, title:typeof content.title === 'string' ? content.title : n.id, required:n.id === targetId || !history.some(r => r.status === 'succeeded'), hasRun:history.some(r => r.status !== 'accepted'), missingPrompt:typeof prompt !== 'string' || !prompt.trim(), hasExpandedOutputs:graph.edges.some(e=>e.kind==='delivery'&&e.sourceId===n.id) };
    });
    const requiresConfirmation = nodes.some(n => n.hasRun) && nodes.length > 1;
    return { targetId, executionRevision:graph.executionRevision, nodes, edges:edges.filter(e => ids.has(e.sourceId) && ids.has(e.targetId)), initialNodeIds:nodes.filter(n => n.required).map(n => n.id), requiresConfirmation, ...(exclude && typeof this.runs.runtime(exclude).details.preserveHistoricalOutputs === 'boolean' ? {preserveHistoricalOutputs:this.runs.runtime(exclude).details.preserveHistoricalOutputs as boolean} : {}) };
  }
  forRun(id: string) { const run = this.runs.get(id); return this.plan(this.graphs.snapshot(run), run.nodeId, id); }
  cancel(id: string, key: string, principal: string): Run {
    this.runs.repo.idempotent(principal + ':chain.cancel:' + id, key, {id}, () => {
      const target = this.runs.get(id);
      const runtime = this.runs.runtime(id);
      if (runtime.details.chainBatch !== id) throw new ServiceError('INVALID_REQUEST', '请从本轮串联主任务停止整体调度。');
      const members = this.db.prepare("SELECT r.id FROM runs r JOIN run_runtime rt ON rt.run_id=r.id WHERE r.project_id=? AND r.graph_id=? AND json_extract(rt.details,'$.chainBatch')=?").all(target.projectId,target.graphId,id);
      this.setMode(id, runtime.details.executionStart as Run['executionStart'], {chainStopRequested:true});
      for (const member of members) {
        const memberId = String(member.id);
        if (isTerminalRunStatus(this.runs.get(memberId).status)) continue;
        this.runs.cancel(memberId, key, principal + ':chain:' + id);
        this.runs.record(memberId, 'workflow', {message:'主任务已请求停止本轮串联调度。',targetRunId:id});
      }
      return {id};
    });
    return this.runs.get(id);
  }
  selection(plan: ExecutionPlan, seeds: string[]): string[] {
    if (!Array.isArray(seeds) || seeds.length > plan.nodes.length || seeds.some(id => typeof id !== 'string' || !plan.nodes.some(n => n.id === id))) throw new ServiceError('INVALID_REQUEST', '执行范围包含无关节点。');
    const selected = new Set([...seeds, ...plan.nodes.filter(n => n.required).map(n => n.id)]);
    const queue = [...selected];
    for (let i=0;i<queue.length;i++) for (const e of plan.edges) if(e.sourceId===queue[i]&&!selected.has(e.targetId)){selected.add(e.targetId);queue.push(e.targetId);}
    const order = executionOrder(plan.edges)!;
    if (!order.includes(plan.targetId)) order.push(plan.targetId);
    return order.filter(id => selected.has(id));
  }
  setMode(id: string, executionStart: Run['executionStart'], extra: Record<string, Json> = {}) {
    const runtime = this.runs.runtime(id);
    this.db.prepare('UPDATE run_runtime SET details=?,revision=revision+1 WHERE run_id=?').run(canonicalJson({...runtime.details,...extra,executionStart:executionStart!}),id);
    const run = this.runs.get(id);
    this.runs.repo.appendEvent({eventId:randomUUID(),type:'run.changed',projectId:run.projectId,graphId:run.graphId,entityId:id,revision:runtime.revision+1,occurredAt:new Date().toISOString(),payload:run as unknown as Json});
  }
  /** Prepare every missing run before entering the auth transaction. No partial batch on failure. */
  async prepareMembers(graph: GraphSnapshot, plan: ExecutionPlan, selected: string[], targetRunId: string | undefined, prepare: (request: SubmitRun) => Promise<(principal:string)=>Run>, preserveHistoricalOutputs = false, prepareHistory?: (nodeId: string, copies: Map<string, string>) => Promise<() => void>) {
    const missing = plan.nodes.filter(n => selected.includes(n.id) && n.missingPrompt);
    if (missing.length) throw new ServiceError('INPUT_BLOCKED', '请先填写以下节点的提示词：' + missing.map(n => n.title).join('、'));
    const historyCopies: (() => void)[] = [];
    const preservedNodes = new Map<string, string>();
    if (preserveHistoricalOutputs) {
      if (!prepareHistory) throw new ServiceError('INPUT_BLOCKED', 'Historical outputs must be prepared before starting');
      for (const id of selected) historyCopies.push(await prepareHistory(id, preservedNodes));
    }
    const members = new Map<string, string>();
    const commits = new Map<string, (principal:string)=>Run>();
    for (const id of selected) {
      if (id === plan.targetId && targetRunId) { members.set(id,targetRunId); continue; }
      const active = this.histories(graph,id).find(r => !isTerminalRunStatus(r.status));
      if (active) {
        if (active.status !== 'accepted' || !['manual','confirm'].includes(active.executionStart ?? '')) throw new ServiceError('ACTIVE_RUN','所选节点已在其他执行计划中运行。');
        members.set(id,active.id);
      } else {
        const node = graph.nodes.find(n => n.id===id)!;
        const content = node.content && typeof node.content==='object'&&!Array.isArray(node.content)?node.content:{};
        commits.set(id,await prepare({serviceId:graph.serviceId,projectId:graph.projectId,graphId:graph.graphId,nodeId:id,kind:'execution',idempotencyKey:randomUUID(),expectedExecutionRevision:graph.executionRevision,...(content.modelOverride ? {modelOverride:content.modelOverride as unknown as import('@openworkgraph/protocol').ModelSelection} : {})}));
      }
    }
    const reused = new Map<string,string>();
    for (const e of plan.edges) if (selected.includes(e.targetId) && !selected.includes(e.sourceId)) {
      const success=this.histories(graph,e.sourceId).filter(r=>r.status==='succeeded').at(-1);
      if(!success)throw new ServiceError('INPUT_BLOCKED','前驱没有可复用的成功结果，请扩大执行范围。');
      reused.set(e.sourceId,success.id);
    }
    return (principal:string, target?:Run) => {
      const committedMembers = new Map(members);
      if(this.graphs.snapshot(graph).executionRevision!==plan.executionRevision)throw new ServiceError('REVISION_CONFLICT','工作图已变化，请重新确认执行范围。');
      if(target)committedMembers.set(plan.targetId,target.id);
      for(const [id,commit] of commits) if(!committedMembers.has(id))committedMembers.set(id,commit(principal).id);
      for(const id of committedMembers.values()){const run=this.runs.get(id);if(run.status!=='accepted'||!['manual','confirm'].includes(run.executionStart??''))throw new ServiceError('CONFLICT','任务已开始或已取消，请刷新。');}
      preservedNodes.clear();
      for (const copy of historyCopies) copy();
      const batch=committedMembers.get(plan.targetId)!;
      for(const [nodeId,id] of committedMembers){
        const dependencies=plan.edges.filter(e=>e.targetId===nodeId).map(e=>committedMembers.get(e.sourceId)??reused.get(e.sourceId)!);
        this.setMode(id,'dependencies',{chainBatch:batch,chainDependencies:dependencies});
        this.runs.record(id,'workflow',{message:'执行范围已确认，等待前驱交付。',targetRunId:batch,predecessorRunIds:dependencies});
      }
      return this.runs.get(batch);
    };
  }
  async pump() {
    if(this.stopped || this.pumping || this.runs.repo.setting('acceptingRuns')!==true)return;
    this.pumping=true;
    try {
      for(const run of this.runs.list().filter(r=>r.status==='accepted'&&r.executionStart==='dependencies')) {
        if (this.runs.get(run.id).status !== 'accepted') continue;
        const runtime=this.runs.runtime(run.id);
        const dependencies=(runtime.details.chainDependencies as string[]).map(id=>this.runs.get(id));
        const failed=dependencies.find(r=>isTerminalRunStatus(r.status)&&r.status!=='succeeded');
        if(failed){this.runs.transition(run.id,runtime,'failed',{error:'前驱任务未成功，已停止下游执行。',failedPredecessorRunId:failed.id});continue;}
        if(dependencies.some(r=>r.status!=='succeeded'))continue;
        try {
          const snapshot=structuredClone(this.runs.snapshot(run.id));
          for(const predecessor of dependencies) {
            const manifestRow=this.db.prepare('SELECT manifest FROM publication_manifests WHERE run_id=?').get(predecessor.id);
            let structuredKeys:Set<string>|undefined;
            if(manifestRow){try{const parsed=JSON.parse(String(manifestRow['manifest'])) as {outputs?:{outputKey?:unknown;role?:unknown}[]};const keys=(parsed.outputs??[]).filter(item=>item.role==='workgraph-node'&&typeof item.outputKey==='string').map(item=>String(item.outputKey));if(keys.length)structuredKeys=new Set(keys);}catch{/* Persisted publication validation owns corruption handling. */}}
            const outputRows=this.db.prepare('SELECT o.output_key,o.resource_id,o.resource_version FROM canvas_outputs o WHERE o.run_id=? ORDER BY o.output_key').all(predecessor.id);
            const outputs=structuredKeys?outputRows.filter(output=>structuredKeys.has(String(output.output_key))):outputRows;
            if(!outputs.length)throw new ServiceError('INPUT_BLOCKED','前驱交付结果不可读取。');
            for(const output of outputs){
              const resource={...this.resources.readCanvasVersion(run,String(output.resource_id),Number(output.resource_version)),resourceId:String(output.resource_id)};
              const bytes=await this.resources.readContent(run,'canvas',resource.resourceId,resource.version);
              if(this.stopped)return;
              const text=resource.mime.startsWith('text/') ? bytes.bytes.toString('utf8') : null;
              snapshot.resources.push({kind:text!==null?'document':resource.mime.startsWith('image/')?'image':'file',sourceNodeIds:[predecessor.nodeId],text,resource});
            }
            const files=this.db.prepare('SELECT relative_path FROM project_file_outputs WHERE run_id=? ORDER BY output_key').all(predecessor.id);
            snapshot.projectFiles??=[];
            for(const file of files)snapshot.projectFiles.push({kind:'file',relativePath:String(file.relative_path),sourceNodeIds:[predecessor.nodeId],edgeIds:[]});
          }
          const textBytes=snapshot.resources.reduce((sum,r)=>sum+Buffer.byteLength(r.text??''),Buffer.byteLength(snapshot.prompt));
          const resourceBytes=snapshot.resources.reduce((sum,r)=>sum+(r.resource?.bytes??0),0);
          if(snapshot.resources.length>64 || textBytes>33554432 || resourceBytes>134217728 || snapshot.resources.some(r=>Buffer.byteLength(r.text??'')>8388608 || (r.resource?.bytes??0)>52428800))throw new ServiceError('INPUT_BUDGET_EXCEEDED','串联输入超过预算。');
          const {inputDigest:_old,...body}=snapshot;
          snapshot.inputDigest=createHash('sha256').update(canonicalJson({baseInputDigest:_old,predecessorRunIds:dependencies.map(r=>r.id),...body} as unknown as Json)).digest('hex');
          atomic(this.db,()=>{
            const current=this.runs.get(run.id);
            if(current.status!=='accepted'||this.runs.runtime(run.id).revision!==runtime.revision)return;
            this.graphs.scope(run);
            this.graphs.retireExecutionOutputs(run,run.nodeId);
            this.db.prepare('INSERT INTO execution_input_snapshots(run_id,payload) VALUES(?,?)').run(run.id,canonicalJson(snapshot as unknown as Json));
            this.db.prepare('UPDATE runs SET input_digest=? WHERE id=?').run(snapshot.inputDigest,run.id);
            for(const envelope of snapshot.resources)if(envelope.resource){const r=envelope.resource;
              if(!this.db.prepare("SELECT 1 FROM canvas_resource_references WHERE run_id=? AND resource_id=? AND resource_version=? AND owner_kind='snapshot'").get(run.id,r.resourceId,r.version))
                this.db.prepare("INSERT INTO canvas_resource_references(id,resource_id,resource_version,graph_id,owner_kind,run_id) VALUES(?,?,?,?,'snapshot',?)").run(randomUUID(),r.resourceId,r.version,run.graphId,run.id);
            }
            this.runs.transition(run.id,runtime,'queued');
          });
        } catch(error) {
          if(this.stopped)return;
          if(this.runs.get(run.id).status==='accepted')this.runs.transition(run.id,this.runs.runtime(run.id),'failed',{error:error instanceof Error?error.message:String(error)});
        }
      }
    } finally {this.pumping=false;}
  }
}
