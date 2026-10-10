import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CanvasResourceVersion, FrozenApiImageRoute, ImageInputMode, ImageRoute, InputSnapshot, Json, ModelSelection, ProjectFileInput, ResourceEnvelope } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { PluginRegistry, readField } from './plugins.js';
import type { PluginInformation } from './plugins.js';
import { normalizeProjectPath, classifyProjectFile } from './project-files.js';
import { readVisualizeBusinessForm, resolveVisualizeFormAssets } from './visualize-content.js';
import { canonicalJson } from './persistence/repositories.js';
import type { VisualizeFormSnapshot, VisualizeInputSnapshot, VisualizeNodeContent } from '@openworkgraph/protocol';

export interface InputBudget { maxItemBytes: number; maxTotalBytes: number; maxResourceItemBytes: number; maxResourceTotalBytes: number; maxResources: number }
export interface PreparedRepresentation { state: 'processing' | 'ready' | 'failed'; resourceSha256: string; representationVersion: number | null; text: string | null; contentHash: string | null }
export interface InputOptions { plugins?: PluginRegistry; budget?: Partial<InputBudget>; readRepresentation?: (resource: CanvasResourceVersion) => PreparedRepresentation | null }
export interface InputIssue { code: 'INPUT_BLOCKED' | 'INPUT_BUDGET_EXCEEDED' | 'PLUGIN_UNAVAILABLE'; nodeId: string; reason: string }
export interface InputSource { edgeId: string; sourceNodeId: string; contentVersion: number; resourceIndexes: number[]; projectFileIndexes: number[]; form?: VisualizeFormSnapshot; preview?: { nodeId: string; contentVersion: number; edgeId: string } }
export interface InputPreview { graphId: string; nodeId: string; executionRevision: number; prompt: string; resources: ResourceEnvelope[]; projectFiles: ProjectFileInput[]; sources: InputSource[]; issues: InputIssue[]; canSubmit: boolean; predecessorCount: number; totalBytes: number }
export type BuildInputOptions = { expectedExecutionRevision?: number; skills?: import('@openworkgraph/protocol').FrozenSkill[]; features?: import('@openworkgraph/protocol').VisualizeFeatureSelection[]; visualizeGeneration?: import('@openworkgraph/protocol').VisualizeGenerationContext } & (
  { model: ModelSelection; imageRoute?: Extract<ImageRoute,{type:'codex'}> }
  | { imageRoute: FrozenApiImageRoute; model?: never }
);
const DEFAULT_BUDGET: InputBudget = {maxItemBytes:8_388_608,maxTotalBytes:33_554_432,maxResourceItemBytes:52_428_800,maxResourceTotalBytes:134_217_728,maxResources:64};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** A DB-only, synchronous builder. No extraction, filesystem or network work belongs here. */
export class InputPreparation {
  private readonly plugins: PluginRegistry;
  private readonly budget: InputBudget;
  constructor(private readonly db: DatabaseSync, private readonly options: InputOptions = {}) {
    this.plugins = options.plugins ?? new PluginRegistry(db); this.budget = {...DEFAULT_BUDGET,...options.budget};
    for (const n of Object.values(this.budget)) if (!Number.isSafeInteger(n) || n < 1) throw new ServiceError('INVALID_REQUEST','Input budgets must be positive safe integers');
  }
  inputPreview(graphId: string, nodeId: string, excludeFiles = false): InputPreview {
    // A savepoint gives standalone previews one read snapshot and nests in the submission transaction.
    this.db.exec('SAVEPOINT input_preparation_read');
    try { const result = this.collect(graphId,nodeId,excludeFiles); this.db.exec('RELEASE input_preparation_read'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO input_preparation_read; RELEASE input_preparation_read'); throw error; }
  }
  /** Shared source/version selection for generation and interactive host sessions. */
  visualizeInputs(graphId: string, nodeId: string): VisualizeInputSnapshot {
    this.db.exec('SAVEPOINT visualize_input_read');
    try {
      const target = this.db.prepare('SELECT n.type,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=? AND n.deleted=0').get(nodeId, graphId);
      if (!target || target['type'] !== 'visualize') throw new ServiceError('NOT_FOUND', '可视化节点不存在。');
      const content = JSON.parse(String(target['content'])) as VisualizeNodeContent;
      const preview = this.collect(graphId, nodeId, false, true);
      if (preview.issues.length) throw new ServiceError(preview.issues[0]!.code, preview.issues.map(issue => issue.nodeId + ': ' + issue.reason).join('; '));
      const bindings = new Map(content.inputBindings.map(binding => [binding.edgeId, binding.name]));
      const edges = new Set(preview.sources.map(source => source.edgeId));
      if (content.inputBindings.some(binding => !edges.has(binding.edgeId))) throw new ServiceError('INPUT_BLOCKED', '输入绑定必须指向当前节点的参考连线。');
      const inputs = preview.sources.map(source => ({ name: bindings.get(source.edgeId) ?? source.edgeId, edgeId: source.edgeId, sourceNodeId: source.sourceNodeId, contentVersion: source.contentVersion, resources: source.resourceIndexes.map(index => preview.resources[index]!), ...(source.projectFileIndexes.length ? { projectFiles: source.projectFileIndexes.map(index => preview.projectFiles[index]!) } : {}), ...(source.form ? { form: source.form } : {}), ...(source.preview ? { preview: source.preview } : {}) }));
      if (new Set(inputs.map(input => input.name)).size !== inputs.length) throw new ServiceError('INPUT_BLOCKED', '输入绑定名称与未命名参考连线标识冲突。');
      const digest = createHash('sha256').update(canonicalJson({ graphId, nodeId, inputs } as unknown as Json)).digest('hex');
      this.db.exec('RELEASE visualize_input_read');
      return freeze({ version: 1, digest, inputs });
    } catch (error) { this.db.exec('ROLLBACK TO visualize_input_read; RELEASE visualize_input_read'); throw error; }
  }
  build(graphId: string, nodeId: string, options: BuildInputOptions): InputSnapshot {
    const preview = this.inputPreview(graphId,nodeId,options.imageRoute?.type === 'api');
    if (options.expectedExecutionRevision !== undefined && options.expectedExecutionRevision !== preview.executionRevision) throw new ServiceError('REVISION_CONFLICT','Graph execution revision changed');
    if (preview.issues.length) throw new ServiceError(preview.issues[0]!.code,preview.issues.map(i => `${i.nodeId}: ${i.reason}`).join('; '));
    const image = preview.resources.some(item=>item.kind==='image' && item.resource);
    const inputMode: ImageInputMode = image ? (preview.prompt.trim() ? 'text_image' : 'image') : 'text';
    const visualizeBindings: import('@openworkgraph/protocol').VisualizeRunInputBinding[] = [];
    for (const source of preview.sources.filter(source => source.form)) {
      const existing = visualizeBindings.find(binding => binding.sourceNodeId === source.sourceNodeId);
      if (existing) { existing.edgeIds.push(source.edgeId); existing.resourceIndexes = [...new Set([...existing.resourceIndexes, ...source.resourceIndexes])]; existing.projectFileIndexes = [...new Set([...(existing.projectFileIndexes ?? []), ...source.projectFileIndexes])]; }
      else visualizeBindings.push({ sourceNodeId: source.sourceNodeId, edgeIds: [source.edgeId], resourceIndexes: [...source.resourceIndexes], projectFileIndexes: [...source.projectFileIndexes] });
    }
    const base = {executionRevision:preview.executionRevision,prompt:preview.prompt,resources:preview.resources,projectFiles:preview.projectFiles,...(visualizeBindings.length ? {visualizeBindings} : {}), ...(options.features?.length ? { features: structuredClone(options.features) } : {}), ...(options.visualizeGeneration ? { visualizeGeneration: structuredClone(options.visualizeGeneration) } : {})};
    let payload: Omit<InputSnapshot,'inputDigest'>;
    if (options.imageRoute?.type === 'api') {
      const route = options.imageRoute;
      if (!route.providerId || !route.modelId || !Number.isSafeInteger(route.configRevision) || route.configRevision < 1 || !Number.isSafeInteger(route.credentialRevision) || route.credentialRevision < 1 || options.model) throw new ServiceError('INVALID_REQUEST','Frozen API image configuration is invalid');
      payload={...base,imageRoute:structuredClone(route),inputMode};
    } else {
      if (!options.model || typeof options.model.model !== 'string' || !options.model.model.trim() || (options.model.reasoningEffort !== null && typeof options.model.reasoningEffort !== 'string')) throw new ServiceError('MODEL_UNAVAILABLE','A valid model selection is required');
      payload={...base,model:{model:options.model.model,reasoningEffort:options.model.reasoningEffort},...(options.skills?.length?{skills:structuredClone(options.skills)}:{}),...(options.imageRoute?{imageRoute:options.imageRoute,inputMode}:{})};
    }
    // Include exact source revisions and edge provenance in the digest without sending ancestors to the model.
    const inputDigest = createHash('sha256').update(JSON.stringify({graphId,nodeId,...payload,sources:preview.sources})).digest('hex');
    return freeze({inputDigest,...payload} as InputSnapshot);
  }
  private collect(graphId: string, nodeId: string, excludeFiles: boolean, visualize = false): InputPreview {
    const graph = this.db.prepare('SELECT execution_revision,archived,trashed,project_id FROM graphs WHERE id=?').get(graphId);
    if (!graph) throw new ServiceError('NOT_FOUND','Graph not found');
    // Schema 4 compatibility for resource fixtures; schema 5 and later filter tombstones.
    const hasDeleted = this.db.prepare('PRAGMA table_info(nodes)').all().some(c => c['name'] === 'deleted');
    const live = hasDeleted ? ' AND n.deleted=0' : '';
    const target = this.db.prepare(`SELECT n.type,n.schema_version,v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=?${live}`).get(nodeId,graphId);
    if (!target) throw new ServiceError('NOT_FOUND','Live target node not found in graph');
    const content = JSON.parse(String(target['content'])) as Json;
    const promptValue = readField(content,'prompt'); const prompt = typeof promptValue === 'string' ? promptValue : '';
    const result: InputPreview = {graphId,nodeId,executionRevision:Number(graph['execution_revision']),prompt,resources:[],projectFiles:[],sources:[],issues:[],canSubmit:false,predecessorCount:0,totalBytes:Buffer.byteLength(prompt)};
    let textBudgetBytes=result.totalBytes,resourceBudgetBytes=0;
    const issue = (id: string, reason: string, code: InputIssue['code'] = 'INPUT_BLOCKED') => result.issues.push({code,nodeId:id,reason});
    if (graph['archived']||graph['trashed']) issue(nodeId,'Graph is archived or trashed');
    if (!(visualize ? ['visualize'] : ['text','image','execution','visualize']).includes(String(target['type']))) issue(nodeId,'Target is not generatable');
    if (this.plugins.inspect(String(target['type']),Number(target['schema_version']),content).state !== 'available') issue(nodeId,'Target contract is unavailable','PLUGIN_UNAVAILABLE');
    if (Buffer.byteLength(prompt) > this.budget.maxItemBytes) issue(nodeId,'提示词超过单项文本预算。','INPUT_BUDGET_EXCEEDED');
    const edgeColumns = this.db.prepare('PRAGMA table_info(edges)').all();
    const order = edgeColumns.some(c => c['name'] === 'input_order') ? 'e.input_order,e.id' : 'e.id';
    const sources = this.db.prepare(`SELECT e.id AS edge_id,e.source_id,n.type,n.schema_version,n.current_version,v.content FROM edges e LEFT JOIN nodes n ON n.id=e.source_id AND n.graph_id=e.graph_id${live} LEFT JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE e.graph_id=? AND e.target_id=? AND e.kind='reference' ORDER BY ${order}`).all(graphId,nodeId);
    result.predecessorCount = new Set(sources.map(s => String(s['source_id']))).size;
    if (result.predecessorCount > 8) issue(nodeId,'More than 8 direct predecessors');
    const dedup = new Map<string,number>();
    const projectFileDedup = new Map<string,number>();
    for (let source of sources) {
      let preview: InputSource['preview'];
      if (source['type'] === 'preview') {
        const previewId = String(source['source_id']);
        if (this.plugins.inspect('preview', Number(source['schema_version']), JSON.parse(String(source['content']))).state !== 'available') { issue(previewId,'Preview contract is unavailable','PLUGIN_UNAVAILABLE'); continue; }
        const originals = this.db.prepare(`SELECT e.id AS edge_id,e.source_id,n.type,n.schema_version,n.current_version,v.content FROM edges e LEFT JOIN nodes n ON n.id=e.source_id AND n.graph_id=e.graph_id${live} LEFT JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE e.graph_id=? AND e.target_id=? AND e.kind='reference'`).all(graphId,previewId);
        if (originals.length === 0) continue;
        if (originals.length !== 1 || originals[0]!['type'] === 'preview') { issue(previewId,'Invalid preview topology'); continue; }
        preview = {nodeId:previewId,contentVersion:Number(source['current_version']),edgeId:String(originals[0]!['edge_id'])};
        source = {...originals[0]!,edge_id:source['edge_id']!};
      }
      const id = String(source['source_id']);
      if (source['content'] === null) { issue(id,'Source node is missing or deleted'); continue; }
      if (source['type'] === 'execution'||source['type']==='group') { issue(id,'Execution and layout group nodes cannot provide input resources'); continue; }
      // An API image route sees file edges only as graph structure, never as a request input.
      if (excludeFiles && source['type'] === 'file') continue;
      let info: PluginInformation;
      try { info = this.plugins.inspect(String(source['type']),Number(source['schema_version']),JSON.parse(String(source['content']))); }
      catch (error) { issue(id,error instanceof Error ? error.message : 'Invalid source content'); continue; }
      if (info.state !== 'available' || !info.contract) { issue(id,info.reason ?? 'Missing contract','PLUGIN_UNAVAILABLE'); continue; }
      const audit: InputSource = {edgeId:String(source['edge_id']),sourceNodeId:id,contentVersion:Number(source['current_version']),resourceIndexes:[],projectFileIndexes:[],...(preview ? {preview} : {})};
      result.sources.push(audit);
      if (source['type'] === 'visualize') {
        try {
          const business = readVisualizeBusinessForm(this.db, { projectId: String(graph['project_id']), graphId }, info.content);
          // Also register this immutable resource in submission preflight discovery.
          const representation = this.options.readRepresentation?.(business.resource);
          if (this.options.readRepresentation && (!representation || representation.state !== 'ready' || representation.resourceSha256 !== business.resource.sha256 || representation.representationVersion !== business.resource.representationVersion)) { issue(id, '业务表单资源尚未就绪或固定版本不匹配。'); continue; }
          const text = canonicalJson(business.form.data), textBytes = Buffer.byteLength(text), resourceBytes = business.resource.bytes;
          if (textBytes > this.budget.maxItemBytes || resourceBytes > this.budget.maxResourceItemBytes) { issue(id, '业务表单超过单项输入预算。', 'INPUT_BUDGET_EXCEEDED'); continue; }
          audit.form = business.form;
          const assets = resolveVisualizeFormAssets(this.db, { projectId: String(graph['project_id']), graphId }, business.form.data);
          for (const asset of assets.resources) {
            const resourceBytes = asset.resource!.bytes;
            if (resourceBytes > this.budget.maxResourceItemBytes) { issue(id, '表单引用资产超过单项文件预算。', 'INPUT_BUDGET_EXCEEDED'); continue; }
            const key = JSON.stringify([asset.kind, asset.text, asset.resource]);
            let index = dedup.get(key);
            if (index === undefined) { index = result.resources.length; dedup.set(key, index); result.resources.push({ ...asset, sourceNodeIds: [id] }); result.totalBytes += resourceBytes; resourceBudgetBytes += resourceBytes; }
            else if (!result.resources[index]!.sourceNodeIds.includes(id)) result.resources[index]!.sourceNodeIds.push(id);
            audit.resourceIndexes.push(index);
          }
          for (const asset of assets.projectFiles) {
            if (excludeFiles) { issue(id, 'API 生图不能读取项目文件引用，请使用 Codex。'); continue; }
            const key = JSON.stringify([asset.kind, asset.relativePath]);
            let index = projectFileDedup.get(key);
            if (index === undefined) { index = result.projectFiles.length; projectFileDedup.set(key, index); result.projectFiles.push({ ...asset, sourceNodeIds: [id], edgeIds: [audit.edgeId] }); }
            else { const file = result.projectFiles[index]!; if (!file.sourceNodeIds.includes(id)) file.sourceNodeIds.push(id); if (!file.edgeIds.includes(audit.edgeId)) file.edgeIds.push(audit.edgeId); }
            audit.projectFileIndexes.push(index);
          }
          const key = JSON.stringify(['text', text, business.resource]);
          const existing = dedup.get(key);
          if (existing !== undefined) {
            const envelope = result.resources[existing]!;
            if (!envelope.sourceNodeIds.includes(id)) envelope.sourceNodeIds.push(id);
            audit.resourceIndexes.push(existing);
          } else {
            const index = result.resources.length; dedup.set(key, index); audit.resourceIndexes.push(index);
            result.resources.push({ kind: 'text', sourceNodeIds: [id], text, resource: business.resource });
            result.totalBytes += textBytes + resourceBytes; textBudgetBytes += textBytes; resourceBudgetBytes += resourceBytes;
          }
        } catch (error) { issue(id, error instanceof Error ? error.message : '业务表单不可读'); }
        continue;
      }
      const sourceDescriptor = info.content && typeof info.content === 'object' && !Array.isArray(info.content) && info.content.source && typeof info.content.source === 'object' && !Array.isArray(info.content.source) ? info.content.source : null;
      if (sourceDescriptor?.kind === 'project-file-empty') { issue(id,'空引用节点尚未关联项目文件。'); continue; }
      if (sourceDescriptor?.kind === 'project-file') {
        if (sourceDescriptor.projectId !== graph['project_id']) { issue(id,'项目文件引用不属于当前项目。'); continue; }
        let relativePath: string;
        try { relativePath = normalizeProjectPath(sourceDescriptor.relativePath); }
        catch (error) { issue(id,error instanceof Error ? error.message : '无效的项目文件路径。'); continue; }
        if (!relativePath) { issue(id,'项目文件引用路径为空。'); continue; }
        const kind = String(source['type']) as ProjectFileInput['kind'];
        if (!['text','image','document','video','file'].includes(kind)) { issue(id,'节点类型不能作为项目文件输入。'); continue; }
        if (excludeFiles) { issue(id,'API 生图不能读取项目文件引用，请先转为独立工作图副本或使用 Codex。'); continue; }
        const key = JSON.stringify([kind,relativePath]);
        const existing = projectFileDedup.get(key);
        if (existing !== undefined) {
          const input = result.projectFiles[existing]!;
          if (!input.sourceNodeIds.includes(id)) input.sourceNodeIds.push(id);
          if (!input.edgeIds.includes(audit.edgeId)) input.edgeIds.push(audit.edgeId);
          audit.projectFileIndexes.push(existing);
        } else {
          const index = result.projectFiles.length; projectFileDedup.set(key,index); audit.projectFileIndexes.push(index);
          result.projectFiles.push({kind,relativePath,sourceNodeIds:[id],edgeIds:[audit.edgeId]});
        }
        continue;
      }
      if (!info.contract.resources.length) issue(id,'Contract provides no resources');
      if (source['type'] === 'file' && !readField(info.content,'resourceId')) continue;
      for (const mapping of info.contract.resources) {
        const rawText = mapping.textField ? readField(info.content,mapping.textField) : undefined;
        if (rawText !== undefined && typeof rawText !== 'string') { issue(id,'Mapped text must be a string'); continue; }
        let text: string | null = typeof rawText === 'string' ? rawText : null;
        let resource: CanvasResourceVersion | null = null;
        const resourceId = mapping.resourceIdField ? readField(info.content,mapping.resourceIdField) : undefined;
        const version = mapping.resourceVersionField ? readField(info.content,mapping.resourceVersionField) : undefined;
        if (resourceId !== undefined || version !== undefined) {
          if (typeof resourceId !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) { issue(id,'Invalid canvas resource identity/version'); continue; }
          const row = this.db.prepare('SELECT v.*,b.bytes FROM canvas_resources r JOIN canvas_resource_versions v ON v.resource_id=r.id JOIN blobs b ON b.sha256=v.sha256 WHERE r.id=? AND r.graph_id=? AND v.version=?').get(resourceId,graphId,version);
          if (!row || !/^[a-f0-9]{64}$/.test(String(row['sha256']))) { issue(id,'Canvas resource/version is missing or belongs to another graph'); continue; }
          resource = {resourceId,version,mime:String(row['mime']),bytes:Number(row['bytes']),sha256:String(row['sha256']),representationVersion:row['representation_version'] === null ? null : Number(row['representation_version'])};
          if ((mapping.kind === 'image' && !resource.mime.startsWith('image/')) || (mapping.kind === 'video' && !resource.mime.startsWith('video/'))) { issue(id,'Resource MIME does not match declared kind'); continue; }
          let prepared: PreparedRepresentation | null | undefined;
          try { prepared = this.options.readRepresentation?.(resource); }
          catch { issue(id,'Prepared representation is unavailable'); continue; }
          if (!prepared || prepared.state !== 'ready') { issue(id,`Resource is ${prepared?.state ?? 'not prepared'}; ready representation required`); continue; }
          if (prepared.resourceSha256 !== resource.sha256 || prepared.representationVersion !== resource.representationVersion) { issue(id,'Prepared resource version/hash mismatch'); continue; }
          if (prepared.text !== null) {
            if (typeof prepared.text === 'string' && Buffer.byteLength(prepared.text) > this.budget.maxItemBytes) { issue(id,'解析后的文本超过单项文本预算。','INPUT_BUDGET_EXCEEDED'); continue; }
            if (typeof prepared.text !== 'string' || createHash('sha256').update(prepared.text).digest('hex') !== prepared.contentHash) { issue(id,'Prepared text hash mismatch'); continue; }
            if (text === null) text = prepared.text;
          }
          if ((mapping.kind === 'video' || mapping.kind === 'document') && (!text?.trim() || resource.representationVersion === null || !prepared.text?.trim())) { issue(id,'Document/video requires a versioned text representation'); continue; }
        }
        if (['image','video','file'].includes(mapping.kind) && !resource) { issue(id,'File/media requires an independent canvas resource'); continue; }
        if (!resource && !text?.trim()) { issue(id,'Resource has no readable content'); continue; }
        const textBytes=Buffer.byteLength(text ?? ''),resourceBytes=resource?.bytes ?? 0,itemBytes=textBytes+resourceBytes;
        if (!Number.isSafeInteger(itemBytes) || itemBytes < 0) issue(id,'Resource size is invalid','INPUT_BUDGET_EXCEEDED');
        if(textBytes>this.budget.maxItemBytes)issue(id,'参考文本超过单项文本预算。','INPUT_BUDGET_EXCEEDED');
        if(resourceBytes>this.budget.maxResourceItemBytes)issue(id,'参考文件超过单项文件预算。','INPUT_BUDGET_EXCEEDED');
        const key = JSON.stringify([mapping.kind,text,resource]);
        const existing = dedup.get(key);
        if (existing !== undefined) {
          const envelope = result.resources[existing]!;
          if (!envelope.sourceNodeIds.includes(id)) envelope.sourceNodeIds.push(id);
          audit.resourceIndexes.push(existing);
        } else {
          const index = result.resources.length; dedup.set(key,index); audit.resourceIndexes.push(index);
          result.resources.push({kind:mapping.kind,sourceNodeIds:[id],text,resource}); result.totalBytes += itemBytes;textBudgetBytes+=textBytes;resourceBudgetBytes+=resourceBytes;
        }
      }
    }
    const ownFiles = readField(content, 'projectFileReferences');
    if (ownFiles !== undefined) {
      if (!Array.isArray(ownFiles) || ownFiles.length > 64) issue(nodeId, '项目文件引用无效。');
      else for (const value of ownFiles) {
        try {
          const relativePath = normalizeProjectPath(readField(value, 'relativePath'));
          const kind = classifyProjectFile(relativePath).type;
          if (excludeFiles && kind === 'file') { issue(nodeId, '当前生成路径不支持此项目文件。'); continue; }
          const existing = result.projectFiles.find(item => item.relativePath === relativePath && item.kind === kind);
          if (existing) { if (!existing.sourceNodeIds.includes(nodeId)) existing.sourceNodeIds.push(nodeId); }
          else result.projectFiles.push({ kind, relativePath, sourceNodeIds: [nodeId], edgeIds: [] });
        } catch { issue(nodeId, '项目相对文件身份无效。'); }
      }
    }
    if (result.resources.length + result.projectFiles.length > this.budget.maxResources) issue(nodeId,'参考资源数量超过限制。','INPUT_BUDGET_EXCEEDED');
    if (textBudgetBytes > this.budget.maxTotalBytes) issue(nodeId,'文本内容总量超过预算。','INPUT_BUDGET_EXCEEDED');
    if (resourceBudgetBytes > this.budget.maxResourceTotalBytes) issue(nodeId,'参考文件总量超过预算。','INPUT_BUDGET_EXCEEDED');
    // Image-only generation needs an actual frozen direct-predecessor image, not merely an edge or text.
    if (!visualize && !prompt.trim() && !(target['type']==='image' && (result.resources.some(item=>item.kind==='image' && item.resource) || result.projectFiles.some(item=>item.kind==='image')))) issue(nodeId,'Own prompt must be nonempty unless an image node has a reference image');
    result.canSubmit = result.issues.length === 0; return result;
  }
}
