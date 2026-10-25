import { useEffect, useMemo, useState } from 'react';
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import type { ExecutionPlan, Run } from '../../../packages/protocol/src/index';
import { randomId } from '../adapter/random';
import type { GraphEditor } from './editor';
import type { Request } from './contracts';
import '../i18n/catalogs/runs';
import '../i18n/catalogs/real-core';
import { useI18n } from '../i18n/I18nProvider';
import { ExecutionDepthPreview, ExecutionDepthDialog } from './ExecutionDepthPreview';

export type ExecutionInputs = { plan:(run:Run)=>Promise<ExecutionPlan>; start:(run:Run,body:Parameters<GraphEditor['startExecution']>[1])=>Promise<Run> };

export function ExecutionStartPanel({run,request,disabled,onChanged,onError,onEditNode,inputs}:{run:Run;request:Request;disabled:boolean;onChanged:()=>void;onError:(error:unknown)=>void;onEditNode?:(nodeId:string)=>void;inputs?:ExecutionInputs}) {
  const { t } = useI18n();
  const [open,setOpen]=useState(run.executionStart==='confirm');
  const [plan,setPlan]=useState<ExecutionPlan>();
  const [seeds,setSeeds]=useState<string[]>([]);
  const [preserve,setPreserve]=useState<boolean>();
  const [busy,setBusy]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const [error,setError]=useState('');
  const [reload,setReload]=useState(0);
  const [key,setKey]=useState(randomId);
  useEffect(()=>{
    if(!open||disabled)return;
    let alive=true,initial=true,signature='',timer:ReturnType<typeof setTimeout>;setPlan(undefined);setError('');
    const read=async()=>{
      try {
        const value=await (inputs ? inputs.plan(run) : request<ExecutionPlan>('/v1/runs/'+encodeURIComponent(run.id)+'/execution-plan'));
        if(alive){const first=initial,next=JSON.stringify(value);if(signature!==next){signature=next;setPlan(value);setKey(randomId());setSeeds(ids=>first?value.initialNodeIds:ids.filter(id=>value.nodes.some(n=>n.id===id)));}initial=false;}
      } catch(e){if(alive){signature='';setPlan(undefined);setError(String(e));onError(e);}}
      finally {if(alive)timer=setTimeout(()=>void read(),2000);}
    };
    void read();
    return()=>{alive=false;clearTimeout(timer);};
  },[run.id,request,inputs,open,disabled,reload]);
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
    try{const body={nodeIds:[...selected],expectedExecutionRevision:plan.executionRevision,idempotencyKey:key,preserveHistoricalOutputs:keepOutputs};await (inputs ? inputs.start(run,body) : request('/v1/runs/'+encodeURIComponent(run.id)+'/start',body,'POST'));onChanged();setOpen(false);}
    catch(e){setError(e instanceof Error?e.message:String(e));onError(e);}
    finally{setBusy(false);}
  };
  const count=plan&&<span className="execution-depth-count">{t('{selected} / {total} will run', { selected: selected.size, total: plan.nodes.length })}</span>;
  const legend=<div className="execution-depth-legend" aria-label={t('Node status legend')}><span><i className="is-selected"/>{t('Will run')}</span><span><i/>{t('Reuse result')}</span><span><i className="is-target"/>{t('Current node')}</span></div>;
  if(run.executionStart==='dependencies')return <section className="interaction-box"><strong>{t('Confirmed execution plan')}</strong><p>{t('Execution will start automatically after predecessors deliver successfully. The Workspace schedules nodes in topological order.')}</p></section>;
  if(!open)return <section className="interaction-box"><strong>{t('Submitted, waiting to start')}</strong><p>{t('The task record was saved. Start it to confirm the execution depth.')}</p><button className="primary-button" disabled={disabled} onClick={()=>setOpen(true)}>{t('Start now')}</button></section>;
  return <section className="interaction-box execution-depth-panel" aria-label={t('Execution depth selection')}>
    <div className="execution-depth-heading"><strong>{t('Select execution depth')}</strong>{count}</div>
    <p className="execution-depth-description">{t('Select predecessor nodes to define the execution scope. Dependencies along the paths are included automatically.')}</p>
    {error&&<p role="alert">{error}<button className="secondary-button" disabled={busy||disabled} onClick={()=>setReload(n=>n+1)}>{t('Read execution scope again')}</button></p>}
    {!plan&&!error&&<p role="status">{t('Reading dependencies…')}</p>}
    {plan&&layout&&<>
      {legend}
      <ExecutionDepthPreview plan={plan} layout={layout} selected={selected} seeds={seeds} busy={busy} disabled={disabled} onToggle={toggle} onExpand={()=>setExpanded(true)}/>
      {expanded&&<ExecutionDepthDialog count={count} onClose={()=>setExpanded(false)}>{legend}<ExecutionDepthPreview plan={plan} layout={layout} selected={selected} seeds={seeds} busy={busy} disabled={disabled} onToggle={toggle}/></ExecutionDepthDialog>}
      <div className="execution-depth-summary"><span>{t('Execution order')}</span><span>{t('{count} nodes total', { count: selected.size })}</span></div>
      {missing.length>0&&<div role="alert"><p>{t('The following nodes are missing prompts. Fill them in before starting. They will be checked again automatically after saving.')}</p><ul>{missing.map(n=><li key={n.id}>{n.title} <button className="secondary-button" disabled={disabled||busy||!onEditNode} onClick={()=>onEditNode?.(n.id)} aria-label={t('Fill in the prompt for {title}', { title: n.title })}>{t('Fill in')}</button></li>)}</ul></div>}
      <ol>{layout.order.filter(id=>selected.has(id)).map(id=><li key={id}>{plan.nodes.find(n=>n.id===id)!.title}</li>)}</ol>
      <label className="run-preserve-outputs"><input type="checkbox" checked={keepOutputs} disabled={busy||disabled} onChange={event=>{setPreserve(event.target.checked);setKey(randomId());}}/><span>{t('Keep historical outputs')}</span></label>
      <div className="button-row"><button className="primary-button" disabled={busy||disabled||missing.length>0} onClick={()=>void start()}>{busy?t('Confirming…'):t('Confirm and start execution')}</button><button className="secondary-button" disabled={busy} onClick={()=>setOpen(false)}>{t('Not now')}</button></div>
    </>}
  </section>;
}
