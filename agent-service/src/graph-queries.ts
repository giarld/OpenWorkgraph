import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GRAPH_READ_DEFAULTS, GRAPH_READ_MAX } from '@openworkgraph/protocol';
import type { Edge, GraphScope, GraphReadBudget, GraphNodeHeading, GraphRegion, Json } from '@openworkgraph/protocol';
import { Graphs } from './graphs.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
const clip=(value:string,count:number)=>Array.from(value).slice(0,count).join('');
const currentTitleSql="COALESCE(g.title,json_extract(v.content,'$.title'),'')";
const invalid = (message:string):never => { throw new ServiceError('INVALID_REQUEST', message); };
export class GraphQueries {
  private key = randomBytes(32);
  constructor(readonly graphs:Graphs) {}
  private sign(value:unknown):string { const data=Buffer.from(JSON.stringify(value)).toString('base64url');return data+'.'+createHmac('sha256',this.key).update(data).digest('base64url'); }
  private decode(input:unknown):Record<string,unknown> {
    if(typeof input!=='string'||input.length>8192)invalid('Invalid read selector.');
    try { const [data,mac,...extra]=(input as string).split('.');const expected=createHmac('sha256',this.key).update(data!).digest(),actual=Buffer.from(mac!,'base64url');
      if(extra.length||expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error();
      return JSON.parse(Buffer.from(data!,'base64url').toString());
    } catch { throw new ServiceError('CURSOR_EXPIRED','Read selector expired or invalid; refresh the first page.'); }
  }
  private budget(input:unknown):GraphReadBudget {
    if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)))invalid('budget must be an object.');
    const value={...GRAPH_READ_DEFAULTS};
    for(const [key,n] of Object.entries(input??{})){if(!(key in value)||!Number.isSafeInteger(n)||Number(n)<(key==='bytes'?4096:1)||Number(n)>GRAPH_READ_MAX[key as keyof GraphReadBudget])invalid('Invalid query budget.');value[key as keyof GraphReadBudget]=Number(n);}
    return value;
  }
  list(projectId:string,request:Record<string,unknown>,principal:string):unknown {
    return atomic(this.graphs.db,()=>{
      this.fields(request,['cursor','limit']);const limit=this.integer(request.limit,30,1,100);
      if(!this.graphs.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))throw new ServiceError('NOT_FOUND','Project not found.');
      const rows=this.graphs.db.prepare('SELECT id,title,execution_revision,layout_revision,archived,trashed FROM graphs WHERE project_id=? ORDER BY id').all(projectId);
      const version=createHash('sha256').update(JSON.stringify(rows)).digest('hex'),identity={serviceId:this.graphs.serviceId,projectId,principal,kind:'graphs',limit};
      const offset=this.offset(request.cursor,identity,version);const items=rows.slice(offset,offset+limit).map(r=>({graphId:r.id,title:r.title,executionRevision:r.execution_revision,layoutRevision:r.layout_revision,archived:!!r.archived,trashed:!!r.trashed}));
      return {serviceId:this.graphs.serviceId,projectId,items,readVersion:version,nextCursor:offset+items.length<rows.length?this.sign({...identity,version,offset:offset+items.length}):null};
    });
  }
  private fields(request:Record<string,unknown>,allowed:string[]) { if(Object.keys(request).some(key=>!allowed.includes(key)))invalid('Unknown query field.'); }
  private integer(input:unknown,fallback:number,min:number,max:number):number { if(input===undefined)return fallback;if(!Number.isSafeInteger(input)||Number(input)<min||Number(input)>max)invalid('Invalid integer query parameter.');return Number(input); }
  private offset(cursor:unknown,identity:unknown,version:string):number {
    if(cursor===undefined)return 0;const value=this.decode(cursor);
    const {version:prior,offset,...rest}=value;
    if(prior!==version||canonicalJson(rest as Json)!==canonicalJson(identity as Json)||!Number.isSafeInteger(offset)||Number(offset)<0)throw new ServiceError('CURSOR_EXPIRED','Query or graph changed; refresh the first page.');
    return Number(offset);
  }
  read(scope:GraphScope,kind:'summary'|'subgraph'|'nodes'|'content',request:Record<string,unknown>,principal:string):unknown {
    return atomic(this.graphs.db,()=>{
      this.fields(request,['budget','cursor',...(kind==='summary'?[]:kind==='subgraph'?['nodeId','region','direction','depth','edgeKinds']:kind==='nodes'?['query','types','searchFields']:['nodeId'])]);
      const budget=this.budget(request.budget),graph=this.graphs.scope(scope),db=this.graphs.db;
      const count=Number(db.prepare('SELECT COUNT(*) n FROM nodes WHERE graph_id=? AND deleted=0').get(scope.graphId)!.n);
      const edgeCount=Number(db.prepare('SELECT COUNT(*) n FROM edges WHERE graph_id=?').get(scope.graphId)!.n);
      if(count>100000||edgeCount>250000)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Graph exceeds synchronous query computation budget.');
      const headings=db.prepare(`SELECT n.id,n.type,n.current_version,n.read_only,substr(${currentTitleSql},1,513) title,g.title group_title FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version LEFT JOIN graph_groups g ON g.id=n.id AND g.run_id IS NULL WHERE n.graph_id=? AND n.deleted=0 ORDER BY n.id`).all(scope.graphId);
      const nodes:GraphNodeHeading[]=headings.map(r=>({id:String(r.id),type:String(r.type),title:clip(String(r.title),budget.titleChars),contentVersion:Number(r.current_version),readOnly:!!r.read_only}));
      const edges:Edge[]=db.prepare('SELECT e.id,e.source_id,e.target_id,e.kind FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id WHERE e.graph_id=? AND s.deleted=0 AND t.deleted=0 ORDER BY e.id').all(scope.graphId).map(r=>({id:String(r.id),sourceId:String(r.source_id),targetId:String(r.target_id),kind:r.kind as Edge['kind']}));
      const members=db.prepare('SELECT m.group_id,m.node_id FROM group_members m JOIN graph_groups g ON g.id=m.group_id JOIN nodes n ON n.id=g.id WHERE g.graph_id=? AND g.run_id IS NULL AND n.deleted=0 ORDER BY m.group_id,m.node_id').all(scope.graphId);
      const version=createHash('sha256').update(JSON.stringify([scope,graph.title,graph.execution_revision,headings.map(n=>[n.id,n.type,n.current_version,n.group_title]),edges,members])).digest('hex');
      const {cursor,...condition}=request,identity={...scope,principal,kind,condition};
      const offset=this.offset(cursor,identity,version);
      const meta={...scope,title:clip(String(graph.title),budget.titleChars),executionRevision:Number(graph.execution_revision),layoutRevision:Number(graph.layout_revision),readVersion:version,budget};
      const page=(items:unknown[],limit:number,extra:Record<string,unknown>,field='items',filtered=false):Record<string,unknown>=>{
        const slice=items.slice(offset,offset+limit);
        const build=()=>({...meta,...extra,[field]:slice,nextCursor:offset+slice.length<items.length?this.sign({...identity,version,offset:offset+slice.length}):null,coverage:{shown:slice.length,total:items.length,omitted:items.length-slice.length,filtered}});
        while(Buffer.byteLength(JSON.stringify(build()))>budget.bytes&&slice.length>1)slice.pop();
        const result=build();if(Buffer.byteLength(JSON.stringify(result))>budget.bytes)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Response exceeds budget; increase bytes or reduce query complexity.');return result;
      };
      if(kind==='content'){
        const node=nodes.find(n=>n.id===request.nodeId);if(!node)throw new ServiceError('NOT_FOUND','Node not found.');
        const row=db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(node.id,node.contentVersion)!;
        const content=String(row.content),chars=Array.from(content);
        let text=chars.slice(offset,offset+budget.textChars).join('');
        const build=()=>({...meta,node,encoding:'json',content:offset===0&&Array.from(text).length===chars.length?JSON.parse(content):null,text,offset,complete:offset+Array.from(text).length>=chars.length,nextCursor:offset+Array.from(text).length<chars.length?this.sign({...identity,version,offset:offset+Array.from(text).length}):null,coverage:{shown:Array.from(text).length,total:chars.length,omitted:chars.length-Array.from(text).length,filtered:false}});
        while(Buffer.byteLength(JSON.stringify(build()))>budget.bytes&&text.length>1)text=Array.from(text).slice(0,Math.max(1,Math.floor(Array.from(text).length/2))).join('');
        const result=build();if(Buffer.byteLength(JSON.stringify(result))>budget.bytes)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Node metadata exceeds response budget.');return result;
      }
      if(kind==='nodes'){
        if(request.query!==undefined&&(typeof request.query!=='string'||request.query.length>2000))invalid('Invalid search query.');
        const fields=request.searchFields??['title','text','prompt'];if(!Array.isArray(fields)||fields.some(f=>!['title','text','prompt'].includes(f)))invalid('Invalid search fields.');
        if(request.types!==undefined&&(!Array.isArray(request.types)||request.types.some(t=>typeof t!=='string'||t.length>128)||request.types.length>16))invalid('Invalid node types.');
        const types=request.types as string[]|undefined,query=String(request.query??'').toLocaleLowerCase();
        let selected=nodes.filter(n=>!types?.length||types.includes(n.type));
        if(query){
          const total=Number(db.prepare('SELECT COALESCE(SUM(length(v.content)),0) n FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.graph_id=? AND n.deleted=0').get(scope.graphId)!.n);
          if(total>32*1024*1024)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Search exceeds 32 MiB text scan budget.');
          const hits=new Map<string,string>();
          for(const row of db.prepare(`SELECT n.id,${currentTitleSql} title,json_extract(v.content,'$.text') text,json_extract(v.content,'$.prompt') prompt FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version LEFT JOIN graph_groups g ON g.id=n.id AND g.run_id IS NULL WHERE n.graph_id=? AND n.deleted=0 ORDER BY n.id`).all(scope.graphId)){
            for(const field of fields as string[]){const text=String(row[field]??''),at=text.toLocaleLowerCase().indexOf(query);if(at>=0){hits.set(String(row.id),Array.from(text.slice(0,at)).slice(-60).join('')+clip(text.slice(at),180));break;}}
          }
          selected=selected.filter(n=>hits.has(n.id)).map(n=>({...n,snippet:hits.get(n.id)!}));
        }
        return page(selected,budget.nodes,{},'items',!!query||!!types?.length);
      }
      const regionMembers=new Map<string,string[]>(),ownership=new Map<string,string>(),known=new Set(nodes.map(n=>n.id));
      let overlap=0;
      const grouped=new Map<string,string[]>();for(const m of members){const id=String(m.group_id),list=grouped.get(id)??[];list.push(String(m.node_id));grouped.set(id,list);}
      for(const node of nodes.filter(n=>n.type==='group')){const ids=[node.id,...(grouped.get(node.id)??[]).filter(id=>known.has(id))];regionMembers.set('g:'+node.id,ids.filter(id=>{if(ownership.has(id)){overlap++;return false;}ownership.set(id,'g:'+node.id);return true;}));}
      const adjacency=new Map<string,string[]>();for(const n of nodes)adjacency.set(n.id,[]);
      for(const edge of edges){adjacency.get(edge.sourceId)!.push(edge.targetId);adjacency.get(edge.targetId)!.push(edge.sourceId);}
      for(const list of adjacency.values())list.sort();
      const visited=new Set(ownership.keys());let regionNumber=0;
      for(const node of nodes){if(visited.has(node.id))continue;const queue=[node.id];visited.add(node.id);const component:string[]=[];
        for(let i=0;i<queue.length;i++){const id=queue[i]!;component.push(id);for(const neighbor of adjacency.get(id)!){if(!visited.has(neighbor)){visited.add(neighbor);queue.push(neighbor);}}}
        for(let i=0;i<component.length;i+=64){const id='s:'+regionNumber++;const chunk=component.slice(i,i+64);regionMembers.set(id,chunk);for(const n of chunk)ownership.set(n,id);}
      }
      const byId=new Map(nodes.map(n=>[n.id,n]));
      const regions:GraphRegion[]=[...regionMembers].map(([id,ids])=>({selector:this.sign({...scope,principal,version,region:id}),source:id.startsWith('g:')?'group':'structure',title:id.startsWith('g:')?byId.get(id.slice(2))!.title:'Region '+(Number(id.slice(2))+1),memberCount:ids.length,...(id.startsWith('g:')?{groupId:id.slice(2)}:{})}));
      if(kind==='summary'){
        const totals={nodes:nodes.length,hiddenOutputs:Number(db.prepare('SELECT COUNT(*) n FROM execution_outputs o JOIN nodes n ON n.id=o.node_id JOIN nodes owner ON owner.id=o.execution_node_id WHERE n.graph_id=? AND n.deleted=1 AND owner.deleted=0').get(scope.graphId)!.n),types:{} as Record<string,number>,edges:{reference:0,execution:0,delivery:0},overlappingMembers:overlap};
        for(const n of nodes)totals.types[n.type]=(totals.types[n.type]??0)+1;for(const e of edges)totals.edges[e.kind]++;
        if(nodes.length<=budget.nodes)return page(edges,budget.edges,{mode:'nodes',totals,nodes,regions:[],relations:[]},'edges');
        const byKey=new Map<string,{source:string;target:string;kind:Edge['kind'];count:number}>();
        for(const e of edges){const source=ownership.get(e.sourceId)!,target=ownership.get(e.targetId)!;if(source===target)continue;const key=source+'|'+target+'|'+e.kind;const old=byKey.get(key);if(old)old.count++;else byKey.set(key,{source,target,kind:e.kind,count:1});}
        const selectorById=new Map([...regionMembers.keys()].map((id,i)=>[id,regions[i]!.selector]));
        const records=[...regions.map(region=>({region})),...[...byKey.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))).map(r=>({relation:{...r,source:selectorById.get(r.source)!,target:selectorById.get(r.target)!}}))];
        const result=page(records,Math.min(budget.regions,budget.edges),{mode:'regions',totals,nodes:[],edges:[]},'records');
        const data=result.records as ({region?:GraphRegion;relation?:unknown})[];const {records:_,...rest}=result;
        return {...rest,regions:data.flatMap(r=>r.region?[r.region]:[]),relations:data.flatMap(r=>r.relation?[r.relation]:[])};
      }
      if((request.nodeId===undefined)===(request.region===undefined))invalid('Specify exactly one nodeId or region.');
      const direction=request.direction??'both';if(!['upstream','downstream','both'].includes(String(direction)))invalid('Invalid direction.');
      const depth=this.integer(request.depth,1,0,16),kinds=request.edgeKinds??['reference','execution','delivery'];if(!Array.isArray(kinds)||!kinds.length||kinds.some(k=>!['reference','execution','delivery'].includes(k)))invalid('Invalid edgeKinds.');
      let roots:string[];
      if(request.region!==undefined){const selector=this.decode(request.region);const expected={...scope,principal,version,region:selector.region};if(canonicalJson(selector as Json)!==canonicalJson(expected as Json)||typeof selector.region!=='string'||!regionMembers.has(selector.region))throw new ServiceError('CURSOR_EXPIRED','Region changed; refresh the summary.');roots=regionMembers.get(selector.region)!;}
      else {if(typeof request.nodeId!=='string'||!known.has(request.nodeId))throw new ServiceError('NOT_FOUND','Node not found.');roots=[request.nodeId];}
      const directed=new Map<string,string[]>();for(const id of known)directed.set(id,[]);
      for(const e of edges.filter(e=>(kinds as string[]).includes(e.kind))){if(direction!=='upstream')directed.get(e.sourceId)!.push(e.targetId);if(direction!=='downstream')directed.get(e.targetId)!.push(e.sourceId);}
      for(const list of directed.values())list.sort();
      const selected=new Set(roots),queue=roots.map(id=>({id,depth:0}));for(let i=0;i<queue.length;i++){const point=queue[i]!;if(point.depth>=depth)continue;for(const id of directed.get(point.id)!){if(!selected.has(id)){selected.add(id);queue.push({id,depth:point.depth+1});}}}
      const all=queue.map(p=>byId.get(p.id)!);
      // Opaque cursor packs the node window and its edge page. Repeated edge
      // pages retain exactly the same heading window and complete ID mapping.
      const nodeOffset=Math.floor(offset/1_000_000_000),windowSize=Math.floor(offset%1_000_000_000/1_000_000),edgeOffset=offset%1_000_000;
      const slice=all.slice(nodeOffset,nodeOffset+(windowSize||budget.nodes));
      do {const ids=new Set(slice.map(n=>n.id)),inner=edges.filter(e=>(kinds as string[]).includes(e.kind)&&ids.has(e.sourceId)&&ids.has(e.targetId));
        const shownEdges=inner.slice(edgeOffset,edgeOffset+budget.edges),moreEdges=edgeOffset+shownEdges.length<inner.length;
        const next=moreEdges?nodeOffset*1_000_000_000+slice.length*1_000_000+edgeOffset+shownEdges.length:nodeOffset+slice.length<all.length?(nodeOffset+slice.length)*1_000_000_000:null;
        const result={...meta,nodes:slice,edges:shownEdges,nextCursor:next===null?null:this.sign({...identity,version,offset:next}),coverage:{shown:slice.length,total:all.length,omitted:all.length-slice.length,filtered:(kinds as string[]).length<3,boundaryEdges:edges.filter(e=>ids.has(e.sourceId)!==ids.has(e.targetId)).length,edgeOffset,shownEdges:shownEdges.length,totalEdges:inner.length,omittedEdges:inner.length-shownEdges.length}};
        if(Buffer.byteLength(JSON.stringify(result))<=budget.bytes)return result;
        if(windowSize)throw new ServiceError('INPUT_BUDGET_EXCEEDED','Saved heading window exceeds bytes; refresh with a smaller edge or node budget.');
        slice.pop();
      }while(slice.length);
      throw new ServiceError('INPUT_BUDGET_EXCEEDED','Subgraph exceeds bytes; reduce edge budget.');
    });
  }
}
