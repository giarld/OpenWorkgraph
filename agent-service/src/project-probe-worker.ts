import { parentPort, workerData } from 'node:worker_threads';
import { discoverProjects } from './project-discovery.js';
import { inspectProjectDirectory } from './projects.js';
import { ServiceError } from './errors.js';
const job = workerData as { kind: 'inspect' | 'discover'; paths?: string[]; codexHome?: string };
if (job.kind === 'discover') parentPort!.postMessage(discoverProjects(job.codexHome));
else parentPort!.postMessage((job.paths ?? []).map(path => {
  try { return {path,value:inspectProjectDirectory(path)}; }
  catch (error) { return {path,error:error instanceof ServiceError ? error.code : 'PROJECT_UNAVAILABLE'}; }
}));
