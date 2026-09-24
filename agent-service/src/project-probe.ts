import { Worker } from 'node:worker_threads';
import type { ErrorCode, ProjectCandidates } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
type Inspection = { canonicalPath: string; isGit: boolean };
type ProbeResult = {path:string; value?:Inspection; error?:ErrorCode};
/** Filesystem calls run outside the event loop and SQLite transactions.
 * Timed-out workers retain their capacity slot until actual exit (bounded stuck mounts). */
export class ProjectProbe {
  private readonly workers = new Map<Worker,() => void>();
  private closed = false;
  constructor(private readonly options: {timeoutMs?:number; maxWorkers?:number; workerUrl?:URL} = {}) {}
  private run<T>(job: unknown): Promise<T> {
    if (this.closed || this.workers.size >= (this.options.maxWorkers ?? 4)) return Promise.reject(new ServiceError('PROJECT_UNAVAILABLE','目录探测繁忙，请稍后重试。'));
    return new Promise((resolve,reject) => {
      const worker = new Worker(this.options.workerUrl ?? new URL('./project-probe-worker.js',import.meta.url),{workerData:job});
      let settled = false;
      const finish = (error: Error | null, value?: T) => {
        if (settled) return; settled=true; clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => {
        finish(new ServiceError('PROJECT_UNAVAILABLE','目录探测超时，未修改项目；请检查挂载设备后重试。'));
        void worker.terminate();
      },this.options.timeoutMs ?? 5000);
      this.workers.set(worker,() => finish(new ServiceError('PROJECT_UNAVAILABLE','服务停止，目录探测已取消。')));
      worker.on('message',(value:T)=>finish(null,value));
      worker.on('error',()=>finish(new ServiceError('PROJECT_UNAVAILABLE','目录探测失败；请检查本机目录。')));
      worker.on('exit',()=>{this.workers.delete(worker);finish(new ServiceError('PROJECT_UNAVAILABLE','目录探测未完成。'));});
      worker.unref();
    });
  }
  async inspect(paths: string[]): Promise<(path:string) => Inspection> {
    const results = await this.run<ProbeResult[]>({kind:'inspect',paths:[...new Set(paths)]});
    const byPath = new Map(results.map(result=>[result.path,result]));
    for (const result of results) if (result.value && !byPath.has(result.value.canonicalPath)) byPath.set(result.value.canonicalPath,result);
    return path => {
      const result=byPath.get(path);
      if (!result) throw new ServiceError('CONFLICT','项目路径在探测期间变化；请刷新后重试。');
      if (!result.value) throw new ServiceError(result.error ?? 'PROJECT_UNAVAILABLE','目录不可用；请检查路径。');
      return result.value;
    };
  }
  async discover(codexHome?:string): Promise<ProjectCandidates> {
    try { return await this.run<ProjectCandidates>({kind:'discover',codexHome}); }
    catch { return {source:'codex-desktop-saved-roots',status:'unavailable',reason:'目录候选探测超时、繁忙或不可用；可手动注册路径。',candidates:[]}; }
  }
  close(): void { this.closed=true; for (const [worker,cancel] of this.workers) {cancel();void worker.terminate();} }
}
