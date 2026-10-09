import { useEffect, useMemo, useState } from 'react';
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import type { ExecutionPlan, Run } from '../../../packages/protocol/src/index';
import { randomId } from '../adapter/random';
import type { Request } from './contracts';
import '../i18n/catalogs/runs';
import '../i18n/catalogs/real-core';
import { useI18n } from '../i18n/I18nProvider';

export function ExecutionStartPanel({run,request,disabled,onChanged,onError,onEditNode}:{run:Run;request:Request;disabled:boolean;onChanged:()=>void;onError:(error:unknown)=>void;onEditNode?:(nodeId:string)=>void}) {
  const { t } = useI18n();
  const [open,setOpen]=useState(run.executionStart==='confirm');
  const [plan,setPlan]=useState<ExecutionPlan>();
  const [seeds,setSeeds]=useState<string[]>([]);
  const [preserve,setPreserve]=useState<boolean>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [reload,setReload]=useState(0);
  const [key,setKey]=useState(randomId);
  useEffect(()=>{
    if(!open||disabled)return;
    let alive=true,initial=true,signature='',timer:ReturnType<typeof setTimeout>;setPlan(undefined);setError('');
    const read=async()=>{
      try {
        const value=await request<ExecutionPlan>('/v1/runs/'+encodeURIComponent(run.id)+'/execution-plan');
        if(alive){const first=initial,next=JSON.stringify(value);if(signature!==next){signature=next;setPlan(value);setKey(randomId());setSeeds(ids=>first?value.initialNodeIds:ids.filter(id=>value.nodes.some(n=>n.id===id)));}initial=false;}
      } catch(e){if(alive){signature='';setPlan(undefined);setError(String(e));onError(e);}}
      finally {if(alive)timer=setTimeout(()=>void read(),2000);}
    };
    void read();
    return()=>{alive=false;clearTimeout(timer);};
  },[run.id,request,open,disabled,reload]);
  const selected=useMemo(()=>{
    const ids=new Set([...(plan?.nodes.filter(n=>n.required).map(n=>n.id)??[]),...seeds]);
    const queue=[...ids];
    for(let i=0;i<queue.length;i++)for(const e of plan?.edges??[])if(e.sourceId===queue[i]&&!ids.has(e.targetId)){ids.add(e.targetId);queue.push(e.targetId);}
    return ids;
  },[seeds,plan]);
  const keepOutputs=preserve ?? plan?.preserveHistoricalOutputs ?? plan?.nodes.some(n=>selected.has(n.id)&&n.hasExpandedOutputs) ?? false;
  const missing=plan?.nodes.filter(n=>selected.has(n.id)&&n.missingPrompt)??[];
  const layout=useMemo(()=>{
    if(!plan)return undefined;
    const order=executionOrder(plan.edges)??[];
    if(!order.includes(plan.targetId))order.push(plan.targetId);
    const layers=new Map<string,number>();
    for(const id of order)layers.set(id,Math.max(0,...plan.edges.filter(e=>e.targetId===id).map(e=>(layers.get(e.sourceId)??0)+1)));
    const counts=new Map<number,number>(),points=new Map<string,{x:number;y:number}>();
    for(const id of order){const layer=layers.get(id)!;counts.set(layer,(counts.get(layer)??0)+1);}
    const width=Math.max(240,Math.max(1,...counts.values())*116+16);
    const offsets=new Map<number,number>();
    for(const id of order){
      const layer=layers.get(id)!,index=offsets.get(layer)??0;
      offsets.set(layer,index+1);
      points.set(id,{x:width/2+(index-(counts.get(layer)!-1)/2)*116,y:40+layer*116});
    }
    return {order,points,width,height:Math.max(0,...layers.values())*116+100};
  },[plan]);
  const toggle=(id:string)=>{if(!busy&&!disabled&&!plan?.nodes.find(n=>n.id===id)?.required){setSeeds(ids=>ids.includes(id)?ids.filter(v=>v!==id):[...ids,id]);setKey(randomId());}};
  const start=async()=>{
    if(!plan||busy||disabled||missing.length)return;setBusy(true);setError('');
    try{await request('/v1/runs/'+encodeURIComponent(run.id)+'/start',{nodeIds:[...selected],expectedExecutionRevision:plan.executionRevision,idempotencyKey:key,preserveHistoricalOutputs:keepOutputs},'POST');onChanged();setOpen(false);}
    catch(e){setError(e instanceof Error?e.message:String(e));onError(e);}
    finally{setBusy(false);}
  };
  if(run.executionStart==='dependencies')return <section className="interaction-box"><strong>{t('Confirmed execution plan')}</strong><p>{t('Execution will start automatically after predecessors deliver successfully. The Workspace schedules nodes in topological order.')}</p></section>;
  if(!open)return <section className="interaction-box"><strong>{t('Submitted, waiting to start')}</strong><p>{t('The task record was saved. Start it to confirm the execution depth.')}</p><button className="primary-button" disabled={disabled} onClick={()=>setOpen(true)}>{t('Start now')}</button></section>;
  return <section className="interaction-box execution-depth-panel" aria-label={t('Execution depth selection')}>
    <div className="execution-depth-heading"><strong>{t('Select execution depth')}</strong>{plan&&<span className="execution-depth-count">{t('{selected} / {total} will run', { selected: selected.size, total: plan.nodes.length })}</span>}</div>
    <p className="execution-depth-description">{t('Select predecessor nodes to define the execution scope. Dependencies along the paths are included automatically.')}</p>
    {error&&<p role="alert">{error}<button className="secondary-button" disabled={busy||disabled} onClick={()=>setReload(n=>n+1)}>{t('Read execution scope again')}</button></p>}
    {!plan&&!error&&<p role="status">{t('Reading dependencies…')}</p>}
    {plan&&layout&&<>
      <div className="execution-depth-legend" aria-label={t('Node status legend')}><span><i className="is-selected"/>{t('Will run')}</span><span><i/>{t('Reuse result')}</span><span><i className="is-target"/>{t('Current node')}</span></div>
      <div className="execution-depth-preview"><svg width={layout.width} height={layout.height} role="group" aria-label={t('Execution dependency preview')}>
        {plan.edges.map(e=>{
          const a=layout.points.get(e.sourceId)!,b=layout.points.get(e.targetId)!;
          const start=a.y+57,end=b.y-25,mid=(start+end)/2;
          return <g key={e.id} className={'execution-depth-edge'+(selected.has(e.sourceId)&&selected.has(e.targetId)?' is-selected':'')}>
            <path d={`M ${a.x} ${start} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${end}`} />
            <path d={`M ${b.x-3} ${end-4} L ${b.x} ${end} L ${b.x+3} ${end-4}`} />
          </g>;
        })}
        {plan.nodes.map(n=>{
          const p=layout.points.get(n.id)!,isSelected=selected.has(n.id),isMissing=isSelected&&n.missingPrompt,isTarget=n.id===plan.targetId;
          const status=isMissing?t('Missing prompt'):isTarget?t('Current node'):n.required?t('Required'):seeds.includes(n.id)?t('Selected'):isSelected?t('Included automatically'):t('Reuse result');
          const title=Array.from(n.title);
          return <g key={n.id} className={'execution-depth-node'+(isSelected?' is-selected':'')+(isTarget?' is-target':'')+(isMissing?' is-missing':'')} transform={`translate(${p.x} ${p.y})`} role="checkbox" aria-label={n.title} aria-checked={isSelected} aria-disabled={n.required||busy||disabled} tabIndex={n.required||busy||disabled?-1:0} onClick={()=>toggle(n.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle(n.id);}}}>
            <title>{t('{title} ({status})', { title: n.title, status })}</title>
            <rect className="execution-depth-hit" x="-54" y="-24" width="108" height="80" rx="12"/>
            <circle className="execution-depth-halo" r="23"/>
            <circle className="execution-depth-disc" r="18"/>
            {isMissing?<path className="execution-depth-symbol" d="M 0 -7 V 2 M 0 7 v .5"/>:isTarget?<path className="execution-depth-play" d="M -4 -7 L 7 0 L -4 7 Z"/>:isSelected?<path className="execution-depth-symbol" d="m -7 0 5 5 9 -10"/>:<path className="execution-depth-symbol" d="M -6 -3 A 7 7 0 1 1 -6 4 M -6 -8 v 5 h 5"/>}
            <text className="execution-depth-title" y="36" textAnchor="middle">{title.length>9?title.slice(0,8).join('')+'…':n.title}</text>
            <text className="execution-depth-status" y="52" textAnchor="middle">{status}</text>
          </g>;
        })}
      </svg></div>
      <div className="execution-depth-summary"><span>{t('Execution order')}</span><span>{t('{count} nodes total', { count: selected.size })}</span></div>
      {missing.length>0&&<div role="alert"><p>{t('The following nodes are missing prompts. Fill them in before starting. They will be checked again automatically after saving.')}</p><ul>{missing.map(n=><li key={n.id}>{n.title} <button className="secondary-button" disabled={disabled||busy||!onEditNode} onClick={()=>onEditNode?.(n.id)} aria-label={t('Fill in the prompt for {title}', { title: n.title })}>{t('Fill in')}</button></li>)}</ul></div>}
      <ol>{layout.order.filter(id=>selected.has(id)).map(id=><li key={id}>{plan.nodes.find(n=>n.id===id)!.title}</li>)}</ol>
      <label className="run-preserve-outputs"><input type="checkbox" checked={keepOutputs} disabled={busy||disabled} onChange={event=>{setPreserve(event.target.checked);setKey(randomId());}}/><span>{t('Keep historical outputs')}</span></label>
      <div className="button-row"><button className="primary-button" disabled={busy||disabled||missing.length>0} onClick={()=>void start()}>{busy?t('Confirming…'):t('Confirm and start execution')}</button><button className="secondary-button" disabled={busy} onClick={()=>setOpen(false)}>{t('Not now')}</button></div>
    </>}
  </section>;
}
