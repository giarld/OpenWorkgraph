import type { GraphNodeHeading, GraphRegion, Edge } from '@openworkgraph/protocol';
import { BusinessCliError } from './business-cli-transport.js';
const clean=(value:unknown)=>Array.from(String(value??'')).map(c=>{const n=c.codePointAt(0)!;return n<32||n>=127&&n<=159||n>=0x202a&&n<=0x202e||n>=0x2066&&n<=0x2069?'[U+'+n.toString(16).padStart(4,'0')+']':c;}).join('');
const NL=String.fromCharCode(10);
export function graphPresentation(value:any):{ascii:string;mapping:unknown[]} {
  const mapping:({alias:string;nodeId?:string;type?:string;title:string;selector?:string})[]=[],lines:string[]=[];
  const nodes=(value.nodes??[]) as GraphNodeHeading[],regions=(value.regions??[]) as GraphRegion[],edges=(value.edges??[]) as Edge[];
  const nodeAliases=new Map<string,string>(),regionAliases=new Map<string,string>();
  lines.push('Work Graph: '+clean(value.title));
  for(const node of nodes){const alias='n'+(nodeAliases.size+1);nodeAliases.set(node.id,alias);mapping.push({alias,nodeId:node.id,type:node.type,title:node.title});lines.push('['+alias+'] '+clean(node.title)+' ('+clean(node.type)+')');}
  const addRegion=(selector:string,title='',count?:number)=>{if(regionAliases.has(selector))return;const alias='s'+(regionAliases.size+1);regionAliases.set(selector,alias);mapping.push({alias,selector,title});lines.push('['+alias+'] '+clean(title)+(count===undefined?' (continued region)':' ('+count+' members)'));};
  for(const region of regions)addRegion(region.selector,region.title,region.memberCount);
  for(const relation of value.relations??[]){addRegion(relation.source);addRegion(relation.target);}
  for(const edge of edges){const source=nodeAliases.get(edge.sourceId),target=nodeAliases.get(edge.targetId);if(!source||!target)throw new BusinessCliError('INTERNAL_ERROR','Graph response contains an unmapped edge.',4);lines.push(source+' --'+edge.kind+'--> '+target);}
  for(const relation of value.relations??[])lines.push(regionAliases.get(relation.source)+' --'+relation.kind+' x'+relation.count+'--> '+regionAliases.get(relation.target));
  if(value.coverage)lines.push('Coverage: '+JSON.stringify(value.coverage));
  if(value.nextCursor)lines.push('More data: repeat the same query with --cursor.');
  return {ascii:lines.join(NL),mapping};
}
export function formatBusinessOutput(value:any,json:boolean,graph=false,maxBytes=1048576):string {
  const presentation=graph?graphPresentation(value):undefined;
  const serialized=json?JSON.stringify(presentation?{...value,...presentation}:value):presentation?presentation.ascii+NL+NL+'Mapping (aliases apply only to this output):'+NL+JSON.stringify(presentation.mapping,null,2)+(value.nextCursor?NL+'Cursor: '+value.nextCursor:''):JSON.stringify(value,null,2);
  const result=Array.from(serialized).map(c=>{const n=c.codePointAt(0)!;return n>=127&&n<=159||n>=0x202a&&n<=0x202e||n>=0x2066&&n<=0x2069?String.fromCharCode(92)+'u'+n.toString(16).padStart(4,'0'):c;}).join('');
  if(Buffer.byteLength(result)+1>maxBytes)throw new BusinessCliError('INPUT_BUDGET_EXCEEDED','Rendered output exceeds the total output budget. Reduce --limit/--edge-limit/--region-limit or increase --output-bytes.',4);
  return result;
}
