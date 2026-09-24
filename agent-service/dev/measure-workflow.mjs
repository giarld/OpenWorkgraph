// Disposable local workload; measurements are observations, not product thresholds.
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir,platform,arch} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {openDatabase,atomic} from '../dist/persistence/database.js';
import {Repositories} from '../dist/persistence/repositories.js';
import {Graphs} from '../dist/graphs.js';
const root=realpathSync(mkdtempSync(join(tmpdir(),'owg-measure-'))),db=openDatabase(join(root,'db'));
try{
  const sid=new Repositories(db).identity(),graphs=new Graphs(db,sid);mkdirSync(join(root,'project'));
  atomic(db,()=>db.prepare("INSERT INTO projects VALUES('p',?,'measurement','active',0)").run(join(root,'project')));
  let graph=graphs.create('p','Measurement','create'),seq=0;
  const measure=(fn)=>{const start=performance.now();const value=fn();return {ms:performance.now()-start,value};};
  const samples=[];
  for(let batch=0;batch<10;batch++){
    const result=measure(()=>graphs.command({...graph,idempotencyKey:'batch-'+batch,expectedExecutionRevision:graph.executionRevision,expectedLayoutRevision:graph.layoutRevision,operations:Array.from({length:100},(_,i)=>({type:'node.create',node:{id:'n'+(batch*100+i),type:'text',schemaVersion:1,contentVersion:1,content:{text:'x'.repeat(1024)},x:i,y:batch,readOnly:false}}))}));graph=result.value;samples.push(result.ms);
  }
  const snapshots=Array.from({length:20},()=>measure(()=>graphs.snapshot(graph)).ms);
  const event=measure(()=>atomic(db,()=>{const repo=new Repositories(db);for(let i=0;i<1000;i++)repo.appendEvent({eventId:'measurement-'+seq++,type:'graph.changed',projectId:'p',graphId:graph.graphId,entityId:graph.graphId,revision:i,occurredAt:new Date().toISOString(),payload:{i}});}));
  const replay=measure(()=>db.prepare('SELECT * FROM events ORDER BY sequence').all());
  const sorted=[...snapshots].sort((a,b)=>a-b);
  console.log(JSON.stringify({node:process.version,platform:platform(),arch:arch(),nodes:1000,contentBytesPerNode:1024,batchSize:100,batchWriteMs:samples,snapshotSamples:20,snapshotMedianMs:sorted[10],snapshotP95Ms:sorted[18],append1000EventsMs:event.ms,replayEvents:replay.value.length,replayMs:replay.ms,rssBytes:process.memoryUsage().rss,threshold:null},null,2));
}finally{db.close();rmSync(root,{recursive:true,force:true});}
