import { parentPort, workerData } from 'node:worker_threads';
import { discoverProjects } from './project-discovery.js';
import { inspectProjectDirectory } from './projects.js';
import { ServiceError } from './errors.js';
type Job = { kind: 'inspect' | 'discover'; paths?: string[]; codexHome?: string };
function run(job: Job) {
  if (job.kind === 'discover') return discoverProjects(job.codexHome);
  return (job.paths ?? []).map(path => {
    try { return {path,value:inspectProjectDirectory(path)}; }
    catch (error) { return {path,error:error instanceof ServiceError ? error.code : 'PROJECT_UNAVAILABLE'}; }
  });
}
if (workerData?.persistent) parentPort!.on('message', (job: Job) => parentPort!.postMessage(run(job)));
else parentPort!.postMessage(run(workerData as Job));
