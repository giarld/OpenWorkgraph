import type { Run, InputSnapshot } from '@openworkgraph/protocol';
import { Runs } from './runs.js';
import { ServiceError } from './errors.js';
import { materializeInputs, type MaterializedInputs } from './input-materialization.js';
import { runDirectories, type DataDirectories } from './directories.js';

export interface RunContextRequest {
  runId: string;
  section: 'summary' | 'snapshot' | 'history' | 'outputs' | 'output';
  outputKey?: string;
  offset?: number;
}
export interface RunLineage {
  version: 1;
  projectId: string;
  rootRunId: string;
  nodes: RunDescription[];
  edges: { sourceRunId: string; targetRunId: string }[];
}
interface RunDescription {
  runId: string; nodeId: string; graphId: string; status: Run['status'];
  inputDigest: string; historyState: Run['historyState'];
  predecessorRunIds: string[]; lineageRecorded: boolean;
  outputs: ReturnType<RunContexts['outputs']>;
  nodeSnapshot: { contentVersion: number | null; title: string | null; promptPreview: string; promptTruncated: boolean; executionRevision: number };
}

/** Run identities, not live graph edges, define historical ancestry. */
export class RunContexts {
  private readonly copies = new Map<string, Promise<MaterializedInputs>>();
  constructor(readonly runs: Runs, readonly dirs: DataDirectories) {}

  private scoped(caller: Run, id: string): Run {
    if (typeof id !== 'string' || !id || id.length > 200) throw new ServiceError('INVALID_REQUEST', 'A valid Run ID is required');
    if (!this.runs.db.prepare('SELECT 1 FROM runs WHERE id=? AND project_id=?').get(id, caller.projectId))
      throw new ServiceError('NOT_FOUND', 'Run is unavailable in the current project');
    return this.runs.get(id);
  }

  describe(run: Run): RunDescription {
    const details = this.runs.runtime(run.id).details;
    const dependencies = details.chainDependencies;
    if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string')))
      throw new ServiceError('INPUT_BLOCKED', 'Invalid persisted Run lineage');
    const predecessorRunIds = [...new Set((dependencies ?? []) as string[])];
    const snapshot = this.runs.snapshot(run.id);
    const version = typeof details.baseVersion === 'number' ? details.baseVersion : null;
    const row = version === null ? undefined : this.runs.db.prepare('SELECT content FROM node_versions WHERE node_id=? AND version=?').get(run.nodeId, version);
    const content = row ? JSON.parse(String(row.content)) : null;
    return {
      runId: run.id, nodeId: run.nodeId, graphId: run.graphId, status: run.status,
      inputDigest: snapshot.inputDigest, historyState: run.historyState, predecessorRunIds, lineageRecorded: dependencies !== undefined, outputs: this.outputs(run),
      nodeSnapshot: { contentVersion: version, title: typeof content?.title === 'string' ? content.title : null,
        promptPreview: snapshot.prompt.slice(0, 2000), promptTruncated: snapshot.prompt.length > 2000, executionRevision: snapshot.executionRevision },
    };
  }

  lineage(runId: string): RunLineage {
    const root = this.runs.get(runId);
    const nodes: RunDescription[] = [], edges: RunLineage['edges'] = [];
    const visited = new Set<string>(), active = new Set<string>();
    const stack = [{ id: runId, exit: false }];
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.exit) { active.delete(entry.id); visited.add(entry.id); continue; }
      if (active.has(entry.id)) throw new ServiceError('INPUT_BLOCKED', 'Persisted Run lineage contains a cycle');
      if (visited.has(entry.id)) continue;
      if (nodes.length >= 10000) throw new ServiceError('INPUT_BUDGET_EXCEEDED', 'Run lineage exceeds 10000 runs');
      const node = this.describe(this.scoped(root, entry.id));
      nodes.push(node); active.add(entry.id); stack.push({ id: entry.id, exit: true });
      for (const id of node.predecessorRunIds) {
        edges.push({ sourceRunId: id, targetRunId: entry.id });
        stack.push({ id, exit: false });
      }
    }
    return { version: 1, projectId: root.projectId, rootRunId: runId, nodes, edges };
  }

  outputs(run: Run) {
    const canvas = this.runs.db.prepare(`SELECT o.output_key AS outputKey, o.resource_id AS resourceId,
      o.resource_version AS version, v.mime, v.sha256, b.bytes
      FROM canvas_outputs o JOIN canvas_resource_versions v ON v.resource_id=o.resource_id AND v.version=o.resource_version
      JOIN blobs b ON b.sha256=v.sha256 WHERE o.run_id=? AND o.graph_id=? ORDER BY o.output_key`).all(run.id, run.graphId);
    const projectFiles = this.runs.db.prepare(`SELECT output_key AS outputKey, relative_path AS relativePath, bytes, sha256
      FROM project_file_outputs WHERE run_id=? AND project_id=? ORDER BY output_key`).all(run.id, run.projectId);
    return { canvas, projectFiles, projectFileNotice: 'Project file paths refer to the live working tree, not frozen historical file contents. Verify their hashes before assuming they match this Run.' };
  }

  async read(callerRunId: string, request: RunContextRequest): Promise<string> {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !['runId', 'section', 'outputKey', 'offset'].includes(key)) ||
        !['summary', 'snapshot', 'history', 'outputs', 'output'].includes(request.section) ||
        !Number.isSafeInteger(request.offset ?? 0) || (request.offset ?? 0) < 0 ||
        (request.section === 'output' ? typeof request.outputKey !== 'string' || !request.outputKey || request.outputKey.length > 1024 : request.outputKey !== undefined))
      throw new ServiceError('INVALID_REQUEST', 'Invalid Run context request');
    const caller = this.runs.get(callerRunId), target = this.scoped(caller, request.runId);
    let value: unknown;
    switch (request.section) {
      case 'summary': value = this.describe(target); break;
      case 'snapshot': value = this.runs.snapshot(target.id); break;
      case 'outputs': value = this.outputs(target); break;
      case 'history':
        value = { historyState: target.historyState, records: target.historyState === 'cleared' ? [] :
          this.runs.db.prepare('SELECT id,occurred_at AS occurredAt,kind,payload FROM run_process_records WHERE run_id=? ORDER BY id').all(target.id)
            .map(row => ({ ...row, payload: JSON.parse(String(row.payload)) })) };
        break;
      case 'output': {
        const output = this.outputs(target).canvas.find(item => item.outputKey === request.outputKey);
        if (!output) throw new ServiceError('NOT_FOUND', 'Published canvas output unavailable; no newer Run or live project file is substituted');
        const resource = { resourceId: String(output.resourceId), version: Number(output.version), mime: String(output.mime),
          sha256: String(output.sha256), bytes: Number(output.bytes), representationVersion: null };
        const key = JSON.stringify([callerRunId, target.id, request.outputKey, resource.sha256]);
        let copy = this.copies.get(key);
        if (!copy) {
          const snapshot: InputSnapshot = { inputDigest: '', executionRevision: 0, prompt: '', model: { model: '', reasoningEffort: null },
            resources: [{ kind: 'file', text: null, sourceNodeIds: [target.nodeId], resource }] };
          copy = materializeInputs(snapshot, { inputDirectory: runDirectories(this.dirs, callerRunId).input, blobDirectory: this.dirs.blobs,
            resolveBlobPath: sha => {
              const row = this.runs.db.prepare('SELECT path FROM resource_blob_files WHERE sha256=?').get(sha);
              if (!row) throw new ServiceError('NOT_FOUND', 'Published output bytes are unavailable');
              return String(row.path);
            } });
          this.copies.set(key, copy);
          copy.catch(() => this.copies.delete(key));
        }
        const file = (await copy).files[0]!;
        value = { ...output, path: file.path, notice: 'Verified immutable output copied to the current Run input directory. Read this file using the available file tools.' };
        break;
      }
    }
    // Page serialized data inside a valid JSON envelope; never truncate the wire JSON.
    const serialized = JSON.stringify(value), offset = request.offset ?? 0;
    if (offset > serialized.length) throw new ServiceError('INVALID_REQUEST', 'Offset exceeds section length');
    let end = Math.min(offset + 4000, serialized.length);
    if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]!)) end--;
    return JSON.stringify({ runId: target.id, section: request.section, encoding: 'json-text', offset,
      nextOffset: end < serialized.length ? end : null, totalCharacters: serialized.length, text: serialized.slice(offset, end) });
  }
}
