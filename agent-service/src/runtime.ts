import { RemoteAssets } from './remote-assets.js';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { subscribeDatabaseChanges } from './persistence/changes.js';
import type { DatabaseSync } from 'node:sqlite';
import { mergeRunInput, parseNodeInputDrafts, type RunInput, type NodeInputDrafts, PROTOCOL_VERSION, SERVICE_VERSION, isTerminalRunStatus, VISUALIZE_DEFAULT_SIZE, VISUALIZE_GENERATION_MAX_SIZE, VISUALIZE_FEATURE_ID } from '@openworkgraph/protocol';
import type { AgentPlatform, AgentSelection, FrozenAgentSelection, Capability, CanvasResourceVersion, Json, Run, ServiceInfo, SubmitRun } from '@openworkgraph/protocol';
import { BlobStore } from './blob-store.js';
import { Graphs } from './graphs.js';
import { prepareOutputHistory } from './execution-output-history.js';
import { GraphFiles } from './graph-files.js';
import { Resources } from './resources.js';
import { PluginRegistry } from './plugins.js';
import { InputPreparation, type PreparedRepresentation } from './inputs.js';
import { ModelDefaultsStore, freezeModelSelection, type BackendModel } from './backend/models.js';
import { CodexBackendAdapter, type AdapterOptions } from './backend/adapter.js';
import { connect, listModels } from './backend/capabilities.js';
import { describeCodexFailure, type CodexStage } from './backend/diagnostics.js';
import { StdioRpc } from './backend/stdio.js';
import { Runs, type RunsDependencies } from './runs.js';
import { ExecutionChains } from './execution-chains.js';
import { History } from './history.js';
import { Scheduler, type SchedulerBackend } from './scheduler.js';
import { Publication } from './publication.js';
import { RuntimeBackend, backendReply } from './runtime-backend.js';
import { acquireProjectLock } from './project-lock.js';
import { ProjectProbe } from './project-probe.js';
import { ProjectFiles } from './project-files.js';
import type { DataDirectories } from './directories.js';
import { atomic } from './persistence/database.js';
import { canonicalJson } from './persistence/repositories.js';
import { ServiceError } from './errors.js';
import { ExecutionSettingsStore } from './execution-settings.js';
import { BuiltinAgentConnections } from './agents/builtin/connections.js';
import { BuiltinAgentCredentials } from './agents/builtin/credentials.js';
import { BuiltinLocalSkills } from './agents/builtin/local-skills.js';
import { createBuiltinAgentPlugin } from './agents/builtin.js';
import { BuiltinSkills, type BuiltinSkillsOptions } from './builtin-skills.js';
import { SkillConfigs } from './skill-configs.js';
import { SkillSessions } from './skill-sessions.js';
import { VisualizePages } from './visualize-pages.js';
import { VisualizePreviews } from './visualize-preview.js';
import { VisualizeInputs } from './visualize-inputs.js';
import { VisualizeBridge } from './visualize-bridge.js';
import { prepareVisualizeRunSlot } from './visualize-run-slots.js';
import { prepareVisualizePromptSlot } from './visualize-prompt-slots.js';
import { prepareVisualizeContentSlot } from './visualize-content-slots.js';
import { VisualizeAssetExport } from './visualize-asset-export.js';
import { VisualizeSuccessors } from './visualize-successors.js';
import { discoverCodexSkills } from './skills-api.js';
import { freezeVisualizeFeatures } from './visualize-features.js';
import { AgentRegistry } from './agents/registry.js';
import { AgentSettingsStore } from './agents/settings.js';
import { AgentDiscovery } from './agents/discovery.js';
import { AgentRouter } from './agents/router.js';
import { assertFrozenAgent } from './agents/freezing.js';
import { AgentError } from './agents/errors.js';
import { normalizeConfiguration } from './agents/configuration.js';
import { nativeSkillCatalog } from './agents/skills.js';
import { createCodexPlugin, codexQueryFailure } from './agents/codex.js';
import { createClaudePlugin, type ClaudePluginOptions } from './agents/claude-code.js';
import { createOpenCodePlugin, type OpenCodePluginOptions } from './agents/opencode.js';
import { AgentWorkspaceConfigurationStore } from './agents/workspace-configuration.js';
import { sameProjectPermissions } from './agents/workspace-configuration-validation.js';
import { resolveProductionSelection } from './agents/production-selection.js';
import type { AgentExecutionSelection } from './agents/contracts.js';
interface AgentPlan { frozen: AgentExecutionSelection; independent: boolean; implicit?: boolean; availabilityRevision?: number; modelPolicy?: import('@openworkgraph/protocol').AgentModelOption }

export interface WorkflowRuntimeOptions {
  logger?: import('./logger.js').Logger;
  backend?: SchedulerBackend; models?: BackendModel[];
  /** Default: discover on model reads/submission. True also probes at startup; false disables execution and discovery. */
  enableBackend?: boolean; backendOptions?: AdapterOptions; claudeOptions?: ClaudePluginOptions; opencodeOptions?: OpenCodePluginOptions;
  skillsOptions?: BuiltinSkillsOptions;
  /** Explicit test/custom composition. Production statically registers the bundled agents. */
  agentRegistry?: AgentRegistry;
}
class RuntimeRuns extends Runs {
  constructor(db: DatabaseSync, serviceId: string, dependencies: RunsDependencies, private readonly available: (run: Run, snapshot: import('@openworkgraph/protocol').InputSnapshot) => boolean) { super(db, serviceId, dependencies); }
  override claimNext(epoch: string, excludedProjects: readonly string[] = [], eligible?: Parameters<Runs['claimNext']>[2]): Run | null {
    // Capability discovery must never turn a persisted queue into failed/reconciling work.
    return super.claimNext(epoch, excludedProjects, (run, snapshot) => this.available(run, snapshot) && (!eligible || eligible(run, snapshot)));
  }
}
const capability = (status: Capability['status'], reason: string, verifiedAt: string | null = null): Capability => ({ status, reason, verifiedAt });
const resourceKey = (resource: CanvasResourceVersion) => JSON.stringify([resource.resourceId, resource.version, resource.sha256, resource.representationVersion]);

export class WorkflowRuntime {
  readonly blobs: BlobStore; readonly graphs: Graphs; readonly resources: Resources; readonly plugins: PluginRegistry;
  readonly inputs: InputPreparation; readonly models: ModelDefaultsStore; readonly runs: Runs; readonly history: History;
  readonly scheduler: Scheduler; readonly publication: Publication;
  readonly executionChains: ExecutionChains;
  readonly graphFiles:GraphFiles;
  readonly executionSettings: ExecutionSettingsStore;
  readonly builtinAgentConnections: BuiltinAgentConnections;
  readonly builtinLocalSkills: BuiltinLocalSkills;
  readonly remoteAssets: RemoteAssets;
  readonly skills: BuiltinSkills;
  readonly skillConfigs: SkillConfigs;
  readonly skillSessions: SkillSessions;
  readonly visualize: VisualizePages;
  readonly visualizePreviews: VisualizePreviews;
  readonly visualizeInputs: VisualizeInputs;
  readonly visualizeBridge: VisualizeBridge;
  readonly agentSettings: AgentSettingsStore | undefined;
  readonly agentDiscovery: AgentDiscovery | undefined;
  readonly agentConfiguration: AgentWorkspaceConfigurationStore | undefined;
  private readonly agentRouter: AgentRouter | undefined;
  private readonly probe = new ProjectProbe();
  private readonly adapter: CodexBackendAdapter | undefined;
  private readonly productionAgents: boolean;
  private availableModels: BackendModel[];
  private timer: NodeJS.Timeout | undefined;
  private pumpWork: Promise<void> | undefined;
  private chainPumpWork: Promise<void> | undefined;
  private pumpAgain = false;
  private stopPumpSubscription: (() => void) | undefined;
  private starting: Promise<void> | undefined;
  private catalogRefresh: Promise<void> | undefined;
  private catalogRpc: StdioRpc | undefined;
  private recovering = false;
  private closed = false; private closing = false; private stopping = false;
  constructor(readonly db: DatabaseSync, readonly serviceId: string, readonly directories: DataDirectories, readonly options: WorkflowRuntimeOptions = {}) {
    this.builtinAgentConnections = new BuiltinAgentConnections(db, new BuiltinAgentCredentials(directories, serviceId));
    this.builtinLocalSkills = new BuiltinLocalSkills(directories);
    if (!options.agentRegistry && !options.backend && options.enableBackend !== false) {
      const registry = new AgentRegistry();
      registry.register(createCodexPlugin({ ...options.backendOptions, cwd: directories.root }));
      registry.register(createClaudePlugin(options.claudeOptions));
      registry.register(createOpenCodePlugin(options.opencodeOptions));
      registry.register(createBuiltinAgentPlugin({ connections: this.builtinAgentConnections, localSkills: this.builtinLocalSkills }));
      this.options = options = { ...options, agentRegistry: registry };
    }
    // A custom static composition must not secretly recover an unregistered
    // Codex through the pre-plugin adapter. Only controlled host injection may
    // supply that legacy test boundary.
    this.productionAgents = !options.backend && options.enableBackend !== false && !!options.agentRegistry;
    this.availableModels = structuredClone(options.models ?? []);
    this.blobs = new BlobStore(directories.blobs); this.resources = new Resources(db, this.blobs);
    this.graphs = new Graphs(db, serviceId); this.remoteAssets = new RemoteAssets(db, serviceId, directories, this.resources, this.graphs); this.plugins = new PluginRegistry(db);
    this.visualize = new VisualizePages(this.graphs, this.resources);
    this.visualizeInputs = new VisualizeInputs(this.graphs, this.resources);
    const successors = new VisualizeSuccessors(this.visualize, async (prompt, projectId) => {
      if (!prompt.skillReferences.length) return;
      const installed = await this.skills.installed();
      const project = this.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(projectId);
      const codex = prompt.skillReferences.some(ref => ref.source === 'codex') ? await discoverCodexSkills(String(project?.canonical_path), this.options.backendOptions) : [];
      const native = new Map<string, Awaited<ReturnType<typeof nativeSkillCatalog>>['skills']>();
      for (const ref of prompt.skillReferences) {
        let candidates: readonly { skillId: string; name: string }[] = ref.source === 'codex' ? codex : installed;
        if (ref.source === 'agent') {
          if (!this.options.agentRegistry || !this.agentSettings) throw new AgentError('runtime_unavailable');
          if (!native.has(ref.backendId)) { const settings = this.agentSettings.get(ref.backendId); native.set(ref.backendId, (await nativeSkillCatalog(this.options.agentRegistry.get(ref.backendId), { backendId: ref.backendId, options: settings.options }, { projectPath: String(project?.canonical_path) })).skills); }
          candidates = native.get(ref.backendId)!;
        }
        if (!candidates.some(item => item.skillId === ref.skillId && item.name === ref.name)) throw new ServiceError('INPUT_BLOCKED', '技能身份不可用，请重新选择：' + ref.name);
      }
    });
    const assetExport = new VisualizeAssetExport(this.visualize);
    this.visualizeBridge = new VisualizeBridge(this.visualize, this.visualizeInputs, { prepareSuccessors: (...args) => successors.prepare(...args), prepareAssetExport: (...args) => assetExport.prepare(...args), prepareRunSlot: (...args) => prepareVisualizeRunSlot(this, ...args), preparePromptSlot: (...args) => prepareVisualizePromptSlot(this.graphs, ...args), prepareContentSlot: (...args) => prepareVisualizeContentSlot(this.graphs, this.resources, ...args) });
    this.graphs.history.backfillActiveGates();
    this.graphFiles = new GraphFiles(db,directories.runs);
    this.executionSettings = new ExecutionSettingsStore(db);
    this.skills = new BuiltinSkills(directories, serviceId, options.skillsOptions);
    this.skillConfigs = new SkillConfigs(directories, serviceId);
    this.skillSessions = new SkillSessions(this.skills, this.skillConfigs, options.backendOptions);
    this.inputs = new InputPreparation(db, { plugins: this.plugins, readRepresentation: resource => this.resources.readPreparedRepresentation(resource) }); this.models = new ModelDefaultsStore(db);
    this.agentSettings = options.agentRegistry ? new AgentSettingsStore(db, options.agentRegistry) : undefined;
    this.agentConfiguration = options.agentRegistry ? new AgentWorkspaceConfigurationStore(directories.config, serviceId, options.agentRegistry) : undefined;
    // Native catalog cold starts have their own startup/request deadlines. Allow
    // the complete production query to finish instead of aborting at ten seconds.
    this.agentDiscovery = options.agentRegistry ? new AgentDiscovery(options.agentRegistry, this.productionAgents ? { ttlMs: 0, timeoutMs: 60_000 } : {}) : undefined;
    this.runs = new RuntimeRuns(db, serviceId, { freeze: () => { throw new ServiceError('INPUT_BLOCKED', 'Use prepareSubmission outside the auth transaction'); }, ...(!options.backend || options.agentRegistry ? { validateReply: (interaction, answer) => { backendReply(interaction, answer); } } : {}) }, (_run,snapshot) => this.runs.runtime(_run.id).details.kind !== 'image_generation' && (snapshot.agent || this.productionAgents ? this.agentEligible(_run.id, snapshot, String(this.runs.runtime(_run.id).details.kind)) : this.executionCapability.status === 'available'));
    this.history = new History(db); this.publication = new Publication(db, directories, this.resources, this.graphs, this.runs);
    this.executionChains = new ExecutionChains(this.runs,this.graphs,this.resources);
    this.adapter = options.backend || this.productionAgents ? undefined : new CodexBackendAdapter(options.backendOptions);
    this.visualizePreviews = new VisualizePreviews(this.runs, directories, this.resources);
    const codexBackend = options.backend ?? (this.adapter ? new RuntimeBackend(this.runs, directories, this.adapter, this.probe, this.skillSessions, {}, this.visualizePreviews) : { start: async () => { throw new AgentError('runtime_unavailable'); }, cancel: async () => 'unknown' as const });
    this.agentRouter = options.agentRegistry ? new AgentRouter(this.runs, directories, id => options.agentRegistry!.get(id), (snapshot, kind) => assertFrozenAgent(options.agentRegistry!, snapshot, String(kind)), codexBackend, this.probe, this.skillSessions, {}, this.productionAgents ? (run, snapshot) => resolveProductionSelection(options.agentRegistry!, snapshot, this.runs.runtime(run.id).details) : undefined, this.visualizePreviews) : undefined;
    const backend = this.agentRouter ?? codexBackend;
    this.scheduler = new Scheduler(this.runs, backend, { projectLockRetryMs: 1000, publish: (run, token) => this.publication.publish(run, token), acquireProjectLock: (_run, path) => acquireProjectLock(path) });
  }
  get catalog(): BackendModel[] { return structuredClone(this.availableModels); }
  async agentOperation(runId: string, attemptId: string, request: Json): Promise<Json> {
    if (!this.agentRouter) throw new AgentError('capability_unsupported');
    return this.agentRouter.operation(runId, attemptId, request);
  }
  private agentEligible(runId: string, snapshot: import('@openworkgraph/protocol').InputSnapshot, kind: string): boolean {
    let reason: string | null = null;
    try {
      if (!this.options.agentRegistry) throw new AgentError('runtime_unavailable');
      if (this.productionAgents) resolveProductionSelection(this.options.agentRegistry, snapshot, this.runs.runtime(runId).details);
      else assertFrozenAgent(this.options.agentRegistry, snapshot, kind);
    } catch (error) {
      // Never persist native errors, paths or plugin-provided free-form messages.
      reason = error instanceof AgentError && ['capability_unsupported', 'invalid_configuration', 'model_unavailable', 'runtime_unavailable', 'protocol_error', 'timeout', 'outcome_unknown'].includes(error.reason) ? error.reason : 'protocol_error';
    }
    const prior = this.db.prepare("SELECT kind,json_extract(payload,'$.reason') AS reason FROM run_process_records WHERE run_id=? AND kind IN ('agent.input_blocked','agent.input_ready') ORDER BY id DESC LIMIT 1").get(runId);
    if (reason !== null) {
      if (prior?.kind !== 'agent.input_blocked' || prior.reason !== reason) this.runs.record(runId, 'agent.input_blocked', { reason });
      return false;
    }
    if (prior?.kind === 'agent.input_blocked') this.runs.record(runId, 'agent.input_ready', {});
    return true;
  }
  private async prepareAgent(selection: AgentSelection, projectId?: string): Promise<AgentPlan> {
    selection = structuredClone(selection);
    if (!this.options.agentRegistry || !this.agentSettings || !this.agentDiscovery) throw new AgentError('runtime_unavailable');
    const project = projectId ? this.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(projectId) : undefined;
    if (projectId && !project) throw new ServiceError('NOT_FOUND', '项目不存在。');
    const projectPath = project ? String(project.canonical_path) : undefined;
    const validateProfile = async (query: import('./agents/discovery.js').AgentDiscoveryRequest) => {
      if (!this.options.agentRegistry!.get(selection.backendId).extensions?.nativeCatalog) return;
      const native = await this.agentDiscovery!.nativeCatalog(selection.backendId, query);
      if (native.profileOption && !native.profiles.some(profile => profile.id === query.options?.[native.profileOption!] && !profile.hidden && profile.mode !== 'subagent')) throw new AgentError('invalid_configuration');
    };
    const availability = this.agentConfiguration?.getBackend(selection.backendId);
    if (availability && !availability.enabled) throw new AgentError('runtime_unavailable');
    if (selection.settingsGeneration !== undefined) {
      if (!this.agentConfiguration) throw new AgentError('runtime_unavailable');
      const current = this.agentConfiguration.getBackend(selection.backendId);
      const plugin = this.options.agentRegistry.get(selection.backendId);
      if (!current.enabled) throw new AgentError('runtime_unavailable');
      const permissions = this.agentConfiguration.get().permissions;
      if (selection.configRevision !== current.revision || !sameProjectPermissions(selection.permissions, permissions)) throw new ServiceError('REVISION_CONFLICT', '工作空间 Agent 配置已变化，请刷新后重试。');
      if (!plugin.projectPermissions) throw new AgentError('capability_unsupported');
      const native = plugin.projectPermissions(permissions.project, { runsPath: this.directories.runs, ...(projectPath ? { projectPath } : {}) });
      const query = { options: normalizeConfiguration(plugin.descriptor.configuration, { ...current.options, ...selection.options, ...native }, selection.schemaVersion), schemaVersion: selection.schemaVersion, ...(projectPath ? { projectPath } : {}) };
      const [catalog, diagnosis] = await Promise.all([this.agentDiscovery.listModels(selection.backendId, query), this.agentDiscovery.diagnose(selection.backendId, query)]);
      if (diagnosis.status === 'unavailable') throw new AgentError(diagnosis.reason ?? 'runtime_unavailable');
      await validateProfile(query);
      const frozen = this.agentConfiguration.freeze(selection, { ...(projectPath ? { projectPath } : {}), availableModels: catalog, runtimeVersion: diagnosis.runtimeVersion ?? null, runsPath: this.directories.runs });
      const modelPolicy = catalog.find(model => model.id === frozen.model.model);
      return { frozen, independent: true, ...(modelPolicy ? { modelPolicy } : {}) };
    }
    const current = this.agentSettings.get(selection.backendId);
    if (!current.enabled) throw new AgentError('runtime_unavailable');
    if (selection.configRevision !== current.revision) throw new ServiceError('REVISION_CONFLICT', '执行器设置已变化，请刷新后重试。');
    const descriptor = this.options.agentRegistry.get(selection.backendId).descriptor;
    const query = { options: normalizeConfiguration(descriptor.configuration, { ...current.options, ...selection.options }, selection.schemaVersion), schemaVersion: selection.schemaVersion, ...(projectPath ? { projectPath } : {}) };
    const [catalog, diagnosis] = await Promise.all([this.agentDiscovery.listModels(selection.backendId, query), this.agentDiscovery.diagnose(selection.backendId, query)]);
    if (diagnosis.status === 'unavailable') throw new AgentError(diagnosis.reason ?? 'runtime_unavailable');
    await validateProfile(query);
    const frozen = this.agentSettings.freeze(selection, { availableModels: catalog, runtimeVersion: diagnosis.runtimeVersion ?? null });
    const modelPolicy = catalog.find(model => model.id === frozen.model.model);
    return { frozen, independent: true, ...(modelPolicy ? { modelPolicy } : {}), ...(availability ? { availabilityRevision: availability.revision } : {}) };
  }
  private nativeSkillCatalog(frozen: Pick<AgentExecutionSelection, 'backendId' | 'options'>, projectPath?: string) { return nativeSkillCatalog(this.options.agentRegistry!.get(frozen.backendId), frozen, { ...(projectPath ? { projectPath } : {}) }); }
  private async prepareImplicitCodex(input: SubmitRun): Promise<AgentPlan> {
    const settings = this.agentSettings!.get('codex');
    if (!settings.enabled || this.agentConfiguration && !this.agentConfiguration.getBackend('codex').enabled) throw new AgentError('runtime_unavailable');
    this.requireAvailable(input);
    const plan = await this.prepareAgent({ backendId: 'codex', configRevision: settings.revision, schemaVersion: settings.schemaVersion, ...(input.modelOverride ? { model: input.modelOverride } : {}) }, input.projectId);
    return { ...plan, implicit: true };
  }
  /** Catalog reads require only the wire handshake, never login or execution self-checks. */
  async refreshModels(): Promise<void> {
    if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', '工作空间正在关闭。');
    if (this.options.backend || this.options.enableBackend === false) return;
    if (this.catalogRefresh) return this.catalogRefresh;
    this.catalogRefresh = (async () => {
      const options = this.options.backendOptions ?? {};
      let rpc: StdioRpc | undefined;
      let stage: CodexStage = 'initialize';
      try {
        if (this.productionAgents) {
          const settings = this.agentSettings!.get('codex');
          this.availableModels = (await this.agentDiscovery!.listModels('codex', { options: settings.options, schemaVersion: settings.schemaVersion })).map(model => ({ ...model, defaultReasoningEffort: model.defaultReasoningEffort ?? null }));
          return;
        }
        rpc = this.catalogRpc = new StdioRpc({ cwd: this.directories.root, ...(options.executable ? { executable: options.executable } : {}), ...(options.args ? { args: options.args } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}) });
        await connect(rpc);
        stage = 'model/list';
        const models = await listModels(rpc);
        if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', '工作空间正在关闭。');
        this.availableModels = models;
      } catch (error) {
        this.availableModels = [];
        const legacyFailure = codexQueryFailure(error);
        if (legacyFailure) throw new ServiceError('MODEL_UNAVAILABLE', legacyFailure.message, { details: legacyFailure.details, retryable: legacyFailure.retryable });
        if (error instanceof ServiceError) throw error;
        const failure = describeCodexFailure(error, rpc, stage);
        throw new ServiceError('MODEL_UNAVAILABLE', failure.message, { details: failure.details, retryable: failure.retryable });
      } finally { rpc?.close(); this.catalogRpc = undefined; }
    })();
    try { await this.catalogRefresh; } finally { this.catalogRefresh = undefined; }
  }
  get executionCapability(): Capability {
    if (this.closed || this.closing) return capability('unavailable', 'Workspace is closing; accepted tasks are retained');
    if (this.options.backend) return capability('available', 'Host-injected controlled backend; not evidence of real Codex execution');
    if (this.options.enableBackend === false) return capability('unavailable', 'Backend discovery explicitly disabled by host');
    if (this.productionAgents && !this.options.agentRegistry!.list().some(plugin => plugin.id === 'codex')) return capability('unavailable', 'Codex is not registered in this Workspace; saved tasks retain their identity');
    return capability('available', '执行由 Codex app-server 提供，沙盒权限使用工作空间设置；提交时检查模型，认证由 Codex 自身处理');
  }
  get capabilities(): ServiceInfo['capabilities'] {
    const local = capability('available', 'Durable local business implementation; authenticated HTTP integration required');
    return { pairing: local, projects: local, graphs: local, assets: local, execution: this.executionCapability, imageGeneration: capability('unavailable', '专用生图已移除，请使用执行节点和生图技能。'), events: local, backups: capability('unknown', 'Backup availability is supplied by host operations integration'), projectFiles:local, projectFileReferences:local };
  }
  get serviceInfo(): ServiceInfo {
    return { serviceId:this.serviceId,version:SERVICE_VERSION,protocolVersion:PROTOCOL_VERSION,capabilities:this.capabilities,imageRoutes:[] };
  }
  private requireAvailable(request: SubmitRun): void {
    if (request.agent) { if (!this.options.agentRegistry) throw new AgentError('runtime_unavailable'); this.options.agentRegistry.get(request.agent.backendId); return; }
    if (this.productionAgents) this.options.agentRegistry!.get('codex');
    const state = this.executionCapability;
    if (state.status !== 'available') throw new ServiceError('NOT_IMPLEMENTED', state.reason);
  }
  previewRunInput(graphId:string,nodeId:string,fields:RunInput,excludeFiles=false) {
    return new InputPreparation(this.db,{plugins:this.plugins,readRepresentation:resource=>this.resources.readPreparedRepresentation(resource),targetInput:{nodeId,fields}}).inputPreview(graphId,nodeId,excludeFiles);
  }
  /** Returns a request-scoped synchronous commit closure; no shared mutable cache. */
  async prepareSubmission(input: SubmitRun, cleanups: (() => unknown)[] = [], principal?: string): Promise<(principal: string) => Run> {
    input = structuredClone(input);
    if (principal) {
      const prior = this.runs.repo.replay(principal + ':run.submit', input.idempotencyKey, input as unknown as Json);
      if (prior) return owner => {
        if (owner !== principal) throw new ServiceError('UNAUTHENTICATED', '提交归属已变化。');
        const replay = this.runs.repo.replay(owner + ':run.submit', input.idempotencyKey, input as unknown as Json);
        if (!replay) throw new ServiceError('CONFLICT', '提交回放状态已变化。');
        return structuredClone(replay) as unknown as Run;
      };
    }
    if(input.nodeInputDrafts!==undefined){try{input.nodeInputDrafts=parseNodeInputDrafts(input.nodeInputDrafts);}catch{throw new ServiceError('INVALID_REQUEST','无效串联输入草稿。');}}
    if (input.kind === 'image_generation') throw new ServiceError('NOT_IMPLEMENTED', '专用生图已移除，请使用执行节点和生图技能。');
    if (input.agent && input.modelOverride) throw new AgentError('invalid_configuration');
    const agentPlan = input.agent ? await this.prepareAgent(input.agent, input.projectId) : this.productionAgents ? await this.prepareImplicitCodex(input) : undefined;
    if(input.nodeInputDrafts && input.kind!=='execution')throw new ServiceError('INVALID_REQUEST','Only execution tasks accept member inputs');
    if(input.kind!=='execution')return this.prepareSingleSubmission(input, true, cleanups, agentPlan);
    const graph=this.graphs.snapshot(input);
    let inputRevision=0;
    if(input.inputDraft){
      const content=this.graphs.runInputContent(input,input.nodeId,input.inputDraft);
      inputRevision=Number(canonicalJson(graph.nodes.find(node=>node.id===input.nodeId)!.content)!==canonicalJson(content));
    }
    if(input.nodeInputDrafts && Object.hasOwn(input.nodeInputDrafts,input.nodeId))throw new ServiceError('INVALID_REQUEST','目标输入须通过 inputDraft 提交。');
    if(!graph.edges.some(e=>e.kind==='execution'&&(e.sourceId===input.nodeId||e.targetId===input.nodeId))){
      if(input.nodeInputDrafts && Object.keys(input.nodeInputDrafts).length)throw new ServiceError('INVALID_REQUEST','串联输入包含无关节点。');
      return this.prepareSingleSubmission(input,false,cleanups,agentPlan);
    }
    const plan=this.executionChains.plan(graph,input.nodeId,undefined,{...input.nodeInputDrafts,...(input.inputDraft ? {[input.nodeId]:input.inputDraft} : {})});
    const outgoing=graph.edges.some(e=>e.kind==='execution'&&e.sourceId===input.nodeId);
    const commit=await this.prepareSingleSubmission(input, true, cleanups, agentPlan);
    const auto=!outgoing&&!plan.requiresConfirmation&&!plan.nodes.some(n=>n.required&&n.missingPrompt);
    const selected=this.executionChains.selection(plan,plan.initialNodeIds);
    const preserve=input.preserveHistoricalOutputs ?? plan.nodes.some(n=>selected.includes(n.id)&&n.hasExpandedOutputs);
    const members=auto?await this.executionChains.prepareMembers(graph,plan,selected,undefined,(request,offset,content)=>request.nodeId===input.nodeId?Promise.resolve(commit):this.prepareChainMember(request,cleanups,agentPlan,offset,content),preserve,(id,copies)=>this.prepareChainOutputHistory(input,id,cleanups,copies),graph.executionRevision+inputRevision,input.nodeInputDrafts):undefined;
    return principal=>atomic(this.db,()=>{
      const run=this.runs.get(commit(principal).id);
      if(run.status!=='accepted'||run.executionStart==='dependencies')return run;
      if(members)return members(principal,run);
      this.executionChains.setMode(run.id,outgoing?'manual':'confirm');
      return this.runs.get(run.id);
    });
  }
  async prepareExecutionStart(id:string,nodeIds:string[],expectedExecutionRevision:number,preserveHistoricalOutputs?:boolean,cleanups:(()=>unknown)[] = [],nodeInputDrafts?:NodeInputDrafts):Promise<(principal:string,key:string)=>Run>{
    if (!Array.isArray(nodeIds)) throw new ServiceError('INVALID_REQUEST', '执行深度必须是节点列表。');
    nodeIds = [...nodeIds];
    if (preserveHistoricalOutputs !== undefined && typeof preserveHistoricalOutputs !== 'boolean') throw new ServiceError('INVALID_REQUEST', 'Invalid historical output option');
    nodeInputDrafts = nodeInputDrafts === undefined ? undefined : structuredClone(nodeInputDrafts);
    const run=this.runs.get(id);
    if(run.status!=='accepted'||!['manual','confirm'].includes(run.executionStart??''))throw new ServiceError('CONFLICT','任务已开始或不可启动。');
    const graph=this.graphs.snapshot(run),plan=this.executionChains.plan(graph,run.nodeId,id,nodeInputDrafts);
    if(plan.executionRevision!==expectedExecutionRevision)throw new ServiceError('REVISION_CONFLICT','工作图已变化，请重新选择执行深度。');
    const selected=this.executionChains.selection(plan,nodeIds);
    if (nodeInputDrafts && Object.keys(nodeInputDrafts).some(id=>!selected.includes(id))) throw new ServiceError('INVALID_REQUEST','串联输入包含未选中的节点。');
    const preserve=preserveHistoricalOutputs ?? plan.preserveHistoricalOutputs ?? plan.nodes.some(n=>selected.includes(n.id)&&n.hasExpandedOutputs);
    const originalSnapshot = this.runs.snapshot(id);
    const inherited = originalSnapshot.agent ?? (this.productionAgents ? resolveProductionSelection(this.options.agentRegistry!, originalSnapshot, this.runs.runtime(id).details) : undefined);
    const agentPlan = inherited ? { frozen: inherited, independent: false, implicit: 'legacy' in inherited } : undefined;
    const members=await this.executionChains.prepareMembers(graph,plan,selected,id,(request,offset,content)=>this.prepareChainMember(request,cleanups,agentPlan,offset,content),preserve,(nodeId,copies)=>this.prepareChainOutputHistory({...run,kind:'execution',expectedExecutionRevision},nodeId,cleanups,copies),graph.executionRevision,nodeInputDrafts);
    return (principal,key)=>this.runs.repo.idempotent(principal+':run.start:'+id,key,{nodeIds,expectedExecutionRevision,...(nodeInputDrafts===undefined?{}:{nodeInputDrafts}),...(preserveHistoricalOutputs === undefined ? {} : {preserveHistoricalOutputs})},()=>members(principal) as unknown as Json) as unknown as Run;
  }
  private async prepareChainMember(request:SubmitRun,cleanups:(()=>unknown)[],inherited:AgentPlan|undefined,offset:number,content:Record<string,Json>) {
    const preference=content.agentModelOverride as {backendId?:string;model?:import('@openworkgraph/protocol').ModelSelection}|null|undefined;
    let agentPlan=inherited;
    if(preference?.backendId && preference.model && this.productionAgents) {
      if(content.modelOverride && preference.backendId!=='codex')throw new AgentError('invalid_configuration');
      const settings=this.agentConfiguration!.getBackend(preference.backendId);
      request.agent={settingsGeneration:'agent-configuration-v1',permissions:this.agentConfiguration!.get().permissions,backendId:preference.backendId,configRevision:settings.revision,schemaVersion:settings.schemaVersion,model:preference.model};
      delete request.modelOverride;
      agentPlan=await this.prepareAgent(request.agent,request.projectId);
    } else if(content.modelOverride && (!inherited || inherited.implicit)) {
      agentPlan=this.productionAgents?await this.prepareImplicitCodex(request):undefined;
    }
    return this.prepareSingleSubmission(request,true,cleanups,agentPlan,offset);
  }
  private async prepareChainOutputHistory(scope: Omit<SubmitRun, 'idempotencyKey'>, nodeId: string, cleanups: (() => unknown)[], copies: Map<string, string>) {
    const request = {...scope,nodeId,kind:'execution' as const,idempotencyKey:randomUUID()} as SubmitRun;
    const commit = await prepareOutputHistory(this.graphs,this.resources,request,cleanups,copies);
    return () => commit(request,this.graphs);
  }
  private async prepareSingleSubmission(input: SubmitRun, holdExecution = true, cleanups: (() => unknown)[] = [], agentPlan?: AgentPlan, commitRevisionOffset=0): Promise<(principal: string) => Run> {
    if (this.db.isTransaction) throw new ServiceError('CONFLICT', 'Preflight must precede the auth transaction');
    const request = structuredClone(input);
    if(request.inputDraft)this.graphs.runInputContent(request,request.nodeId,request.inputDraft);
    const targetInput=request.inputDraft?{nodeId:request.nodeId,fields:request.inputDraft}:undefined;
    if (agentPlan) {
      if (!agentPlan.implicit && request.modelOverride) throw new AgentError('invalid_configuration');
      if (!agentPlan.implicit && !request.agent && !('legacy' in agentPlan.frozen)) request.agent = { backendId: agentPlan.frozen.backendId, configRevision: agentPlan.frozen.configRevision, schemaVersion: agentPlan.frozen.schemaVersion, options: { ...agentPlan.frozen.options }, model: { ...agentPlan.frozen.model } };
    }
    if (request.preserveHistoricalOutputs !== undefined && (typeof request.preserveHistoricalOutputs !== 'boolean' || request.kind !== 'execution')) throw new ServiceError('INVALID_REQUEST', 'Only execution tasks can preserve historical outputs');
    if(request.imageRoute)throw new ServiceError('INVALID_REQUEST','Dedicated image routes have been removed');
    if(!agentPlan){this.requireAvailable(request);await this.refreshModels();}
    const executionSettings = agentPlan ? null : this.executionSettings.get();
    if (request.serviceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', 'Wrong service');
    const project = this.db.prepare('SELECT canonical_path,state FROM projects WHERE id=?').get(request.projectId);
    if (!project) throw new ServiceError('NOT_FOUND', 'Project not found');
    if (project.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', 'Project is inactive');
    const path = String(project.canonical_path); const inspected = await this.probe.inspect([path]);
    if (inspected(path).canonicalPath !== path) throw new ServiceError('PROJECT_UNAVAILABLE', 'Stored project path no longer resolves to itself');
    const versions = new Map<string, CanvasResourceVersion>();
    // Discover only direct input resources using the same declarative mappings.
    const discovery = new InputPreparation(this.db, { plugins: this.plugins, ...(targetInput?{targetInput}:{}), readRepresentation: resource => { versions.set(resourceKey(resource), resource); return { state: 'ready', resourceSha256: resource.sha256, representationVersion: resource.representationVersion, text: null, contentHash: null }; } });
    const preview = discovery.inputPreview(request.graphId, request.nodeId);
    if (preview.executionRevision !== request.expectedExecutionRevision) throw new ServiceError('REVISION_CONFLICT', 'Graph changed before preflight');
    const unsupportedProjectFile = preview.issues.find(item => item.reason.startsWith('API 生图不能读取项目文件引用'));
    if (unsupportedProjectFile) throw new ServiceError(unsupportedProjectFile.code, unsupportedProjectFile.reason);
    if (preview.projectFiles.length) {
      const states = await new ProjectFiles(this.db).statReferences(request.projectId, preview.projectFiles);
      const unavailable = states.find(item => item.state !== 'available');
      if (unavailable) throw new ServiceError(unavailable.state === 'missing' ? 'INPUT_BLOCKED' : 'PROJECT_UNAVAILABLE', '项目文件引用当前不可读：' + unavailable.path);
    }
    const prepared = new Map<string, PreparedRepresentation>();
    const fileIds = new Set(preview.resources.filter(item => item.kind === 'file').map(item => item.resource?.resourceId));
    for (const [key, resource] of versions) {
      let text: string | null = null;
      if (resource.mime.startsWith('image/') || fileIds.has(resource.resourceId)) await this.resources.readContent(request, 'canvas', resource.resourceId, resource.version);
      else {
        const representation = await this.resources.representation(request, 'canvas', resource.resourceId, resource.version);
        if (representation.state !== 'ready' || (resource.representationVersion !== null && representation.version !== resource.representationVersion)) throw new ServiceError('INPUT_BLOCKED', representation.reason ?? 'Required immutable representation unavailable');
        text = representation.text;
      }
      prepared.set(key, Object.freeze({ state: 'ready', resourceSha256: resource.sha256, representationVersion: resource.representationVersion, text, contentHash: text === null ? null : createHash('sha256').update(text).digest('hex') }));
    }
    const scopedInputs = new InputPreparation(this.db, { plugins: this.plugins, ...(targetInput?{targetInput}:{}), readRepresentation: resource => prepared.get(resourceKey(resource)) ?? null });
    const scopedPreview = scopedInputs.inputPreview(request.graphId,request.nodeId);
    const targetContent = this.db.prepare('SELECT v.content FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version WHERE n.id=? AND n.graph_id=?').get(request.nodeId, request.graphId);
    const nodeContent = mergeRunInput(targetContent ? JSON.parse(String(targetContent.content)) as Json : {},request.inputDraft);
    const skillReferences = nodeContent.skillReferences;
    const features = freezeVisualizeFeatures(nodeContent.features, request.kind === 'visualize_generation');
    if (features.length && !['execution', 'visualize_generation'].includes(request.kind)) throw new ServiceError('INPUT_BLOCKED', '可视化功能仅用于执行交付或可视化节点生成。');
    let visualizeGeneration: import('@openworkgraph/protocol').VisualizeGenerationContext | undefined;
    if (request.kind === 'visualize_generation') {
      const stored = await this.visualize.read(request, request.nodeId);
      const inputs = await this.visualizeInputs.capture(request, request.nodeId);
      const node = this.graphs.snapshot(request).nodes.find(item => item.id === request.nodeId)!;
      const current = { width: node.width ?? VISUALIZE_DEFAULT_SIZE.width, height: node.height ?? VISUALIZE_DEFAULT_SIZE.height };
      visualizeGeneration = { version: 1, feature: { kind: 'builtin-feature', featureId: VISUALIZE_FEATURE_ID, version: 1 }, inputs, layout: { default: { ...VISUALIZE_DEFAULT_SIZE }, current, maximum: { ...VISUALIZE_GENERATION_MAX_SIZE }, contentViewport: { width: current.width, height: Math.max(1, current.height - 48) } }, replacementPolicy: 'new-initial-form', ...(stored.page && stored.content.form ? { previous: { page: stored.page, formFormatReference: stored.content.form } } : {}) };
    }
    const nativeSkills = agentPlan ? this.options.agentRegistry!.get(agentPlan.frozen.backendId).extensions?.nativeSkills?.automatic === true || scopedPreview.prompt.includes('$') || Array.isArray(skillReferences) && skillReferences.some(ref => typeof ref === 'object' && ref !== null && (ref as { source?: string }).source !== 'openworkgraph')
      ? await this.nativeSkillCatalog(agentPlan.frozen, path)
      : { backendId: agentPlan.frozen.backendId, configuredSkills: this.options.agentRegistry!.get(agentPlan.frozen.backendId).descriptor.capabilities.configuredSkills, dynamicSkillCommands: this.options.agentRegistry!.get(agentPlan.frozen.backendId).descriptor.capabilities.dynamicSkillCommands, skills: [] } : undefined;
    const frozenSkills = await this.skillSessions.freeze(scopedPreview.prompt, skillReferences, path, nativeSkills);
    if (agentPlan?.modelPolicy) {
      const availability = this.options.agentRegistry!.evaluate(agentPlan.frozen.backendId, {
        kind: request.kind, platform: process.platform as AgentPlatform, options: agentPlan.frozen.options, model: agentPlan.frozen.model,
        modelCapabilities: agentPlan.modelPolicy, skills: frozenSkills, resources: scopedPreview.resources, projectFiles: scopedPreview.projectFiles,
        inputKinds: [...new Set([...scopedPreview.resources.map(resource => resource.kind), ...scopedPreview.projectFiles.map(file => file.kind)])],
        visualize: request.kind === 'execution' && features.length > 0,
      });
      if (availability.status !== 'available') throw new AgentError(availability.reason ?? 'capability_unsupported');
    }
    const preserveOutputs = request.preserveHistoricalOutputs && !holdExecution ? await prepareOutputHistory(this.graphs, this.resources, request, cleanups) : undefined;
    const scoped = new Runs(this.db, this.serviceId, {
      ...(preserveOutputs ? { preserveOutputs } : {}),
      validate: (_request, context) => {
        if (agentPlan) {
          if (agentPlan.independent && !('legacy' in agentPlan.frozen)) {
            if (agentPlan.frozen.settingsGeneration) this.agentConfiguration!.assertCurrent(agentPlan.frozen);
            else this.agentSettings!.assertCurrent(agentPlan.frozen);
          }
          if (agentPlan.frozen.backendId === 'codex') context.sandboxMode = agentPlan.frozen.options.sandboxMode as import('@openworkgraph/protocol').SandboxMode;
        } else {
          this.requireAvailable(request);
          if (this.executionSettings.get().revision !== executionSettings!.revision) throw new ServiceError('REVISION_CONFLICT', '权限设置已变化，请重新提交任务。');
          context.sandboxMode = executionSettings!.sandboxMode;
          try { this.models.freeze(request.modelOverride, this.availableModels); } catch { throw new ServiceError('MODEL_UNAVAILABLE', 'Selected model/effort is unavailable; choose explicitly'); }
        }
        if (context.canonicalPath !== path) throw new ServiceError('REVISION_CONFLICT', 'Project path changed while preparing inputs');
      },
      freeze: () => { const snapshot = scopedInputs.build(request.graphId, request.nodeId, {expectedExecutionRevision:request.expectedExecutionRevision,model:agentPlan?.frozen.model ?? this.models.freeze(request.modelOverride,this.availableModels),...(agentPlan && !('legacy' in agentPlan.frozen) ? {agent:agentPlan.frozen} : {}),skills:frozenSkills,features,...(request.kind === 'execution' && ['create','convert'].includes(String(nodeContent.skillAuthoring)) ? {skillAuthoring:nodeContent.skillAuthoring as 'create' | 'convert'} : {}),...(visualizeGeneration ? { visualizeGeneration } : {})}); if (snapshot.agent) assertFrozenAgent(this.options.agentRegistry!, snapshot, request.kind); return snapshot; },
    });
    return principal => { request.expectedExecutionRevision=input.expectedExecutionRevision+commitRevisionOffset; return agentPlan?.independent && !('legacy' in agentPlan.frozen) && agentPlan.frozen.settingsGeneration
      ? this.agentConfiguration!.withCurrent(agentPlan.frozen, () => scoped.submit(request, principal, request.kind==='execution' && holdExecution))
      : agentPlan?.independent && agentPlan.availabilityRevision !== undefined
        ? this.agentConfiguration!.withEnabledBackend(agentPlan.frozen.backendId, agentPlan.availabilityRevision, () => scoped.submit(request, principal, request.kind==='execution' && holdExecution))
      : scoped.submit(request, principal, request.kind==='execution' && holdExecution); };
  }
  async prepareContinuation(id: string): Promise<(principal: string, idempotencyKey: string) => Run> {
    if (this.db.isTransaction) throw new ServiceError('CONFLICT', 'Continuation preflight must precede auth transaction');
    const run = this.runs.get(id); const token = this.runs.runtime(id);
    const replay = (work: () => Run) => (principal: string, key: string): Run => this.runs.repo.idempotent(principal + ':run.continue:' + id, key, { id }, () => work() as unknown as Json) as unknown as Run;
    if (run.status !== 'paused_restore') return replay(() => { throw new ServiceError('CONFLICT', 'Only explicitly paused restored Runs can continue'); });
    const snapshot = this.runs.snapshot(id); const snapshotJson = canonicalJson(snapshot as unknown as Json);
    if (token.details.kind === 'image_generation' || snapshot.imageRoute?.type === 'api') throw new ServiceError('NOT_IMPLEMENTED', '专用生图已移除，历史任务不能重新执行。');
    if (snapshot.agent) {
      if (!this.options.agentRegistry) throw new AgentError('runtime_unavailable');
      assertFrozenAgent(this.options.agentRegistry, snapshot, String(token.details.kind), true);
      await this.skillSessions.environment(snapshot.skills ?? [], true);
      const projectPath = this.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(run.projectId)?.canonical_path;
      const native = (snapshot.skills ?? []).filter(skill => skill.source === 'agent');
      if (native.some(skill => skill.backendId !== snapshot.agent!.backendId)) throw new AgentError('capability_unsupported');
      const extension = this.options.agentRegistry.get(snapshot.agent.backendId).extensions?.nativeSkills;
      if (native.length && extension?.validateFrozen && typeof projectPath === 'string') await extension.validateFrozen(projectPath, native);
      else if (native.length) {
        const catalog = await this.nativeSkillCatalog(snapshot.agent, typeof projectPath === 'string' ? projectPath : undefined);
        if (native.some(skill => !catalog.skills.some(item => item.skillId === skill.skillId && item.name === skill.name))) throw new AgentError('capability_unsupported');
      }
    } else if (this.productionAgents) {
      const legacy = resolveProductionSelection(this.options.agentRegistry!, snapshot, token.details, true);
      const models = await this.agentDiscovery!.listModels(legacy.backendId, { options: { ...legacy.options }, schemaVersion: legacy.schemaVersion });
      const frozen = freezeModelSelection(legacy.model, models.map(model => ({ ...model, defaultReasoningEffort: model.defaultReasoningEffort ?? null })));
      if (canonicalJson(frozen as unknown as Json) !== canonicalJson(snapshot.model as unknown as Json)) throw new AgentError('model_unavailable');
      await this.skillSessions.environment(snapshot.skills ?? [], true);
    } else {this.requireAvailable({ kind: token.details.kind } as SubmitRun);await this.refreshModels();await this.skillSessions.environment(snapshot.skills ?? [], true);}
    const project = this.db.prepare('SELECT state,canonical_path FROM projects WHERE id=?').get(run.projectId);
    if (!project || project.state !== 'active') throw new ServiceError('PROJECT_INACTIVE', 'Restored project is inactive');
    const path = String(project.canonical_path);
    if (path !== token.details.canonicalPath) throw new ServiceError('PROJECT_UNAVAILABLE', 'Restored Run cannot be reassigned to another project path');
    const inspect = await this.probe.inspect([path]);
    if (inspect(path).canonicalPath !== path) throw new ServiceError('PROJECT_UNAVAILABLE', 'Restored project path no longer resolves to itself');
    if ((snapshot.projectFiles ?? []).length) {
      const states = await new ProjectFiles(this.db).statReferences(run.projectId, snapshot.projectFiles!);
      const unavailable = states.find(item => item.state !== 'available');
      if (unavailable) throw new ServiceError(unavailable.state === 'missing' ? 'INPUT_BLOCKED' : 'PROJECT_UNAVAILABLE', '项目文件引用当前不可读：' + unavailable.path);
    }
    const validateFrozen = () => {
      if (snapshot.inputDigest !== run.inputDigest || !snapshot.prompt.trim()) throw new ServiceError('INPUT_BLOCKED', 'Invalid restored input snapshot');
      if (snapshot.agent) { assertFrozenAgent(this.options.agentRegistry!, snapshot, String(token.details.kind), true); return; }
      if (this.productionAgents) { resolveProductionSelection(this.options.agentRegistry!, snapshot, token.details, true); return; }
      if (!snapshot.model) throw new ServiceError('INPUT_BLOCKED','Codex model is missing from restored snapshot');
      try {
        const frozen = freezeModelSelection(snapshot.model, this.availableModels);
        if (canonicalJson(frozen as unknown as Json) !== canonicalJson(snapshot.model as unknown as Json)) throw Error('Changed model defaults');
      } catch { throw new ServiceError('MODEL_UNAVAILABLE', 'Frozen model/effort unavailable; no substitution is permitted'); }
    };
    validateFrozen();
    for (const envelope of snapshot.resources) {
      const resource = envelope.resource; if (!resource) continue;
      const metadata = this.resources.readCanvasVersion(run, resource.resourceId, resource.version);
      if (metadata.sha256 !== resource.sha256 || metadata.bytes !== resource.bytes || metadata.representationVersion !== resource.representationVersion) throw new ServiceError('INPUT_BLOCKED', 'Frozen resource version changed');
      await this.resources.readContent(run, 'canvas', resource.resourceId, resource.version);
    }
    return replay(() => {
      if (this.runs.repo.setting('acceptingRuns') !== true) throw new ServiceError('MAINTENANCE', 'Service is not accepting continuations');
      if (!snapshot.agent && !this.productionAgents) this.requireAvailable({ kind: token.details.kind } as SubmitRun); validateFrozen();
      const current = this.runs.runtime(id);
      const target = this.db.prepare('SELECT p.state,p.canonical_path,g.archived,g.trashed,n.deleted,n.read_only FROM projects p JOIN graphs g ON g.project_id=p.id JOIN nodes n ON n.graph_id=g.id WHERE p.id=? AND g.id=? AND n.id=?').get(run.projectId, run.graphId, run.nodeId);
      if (!target || target.state !== 'active' || target.canonical_path !== path || target.archived || target.trashed || target.deleted || target.read_only) throw new ServiceError('PROJECT_UNAVAILABLE', 'Restored target changed or is read-only');
      if (current.epoch !== token.epoch || current.revision !== token.revision || canonicalJson(this.runs.snapshot(id) as unknown as Json) !== snapshotJson) throw new ServiceError('REVISION_CONFLICT', 'Restored Run changed during preflight');
      const pendingChain = token.details.executionStart && !this.db.prepare('SELECT 1 FROM execution_input_snapshots WHERE run_id=?').get(id);
      return this.runs.transition(id, token, pendingChain ? 'accepted' : 'queued');
    });
  }
  get ready(): Promise<void> { return this.starting ?? this.start(); }
  private active(): Run[] { return this.runs.active(); }
  private schedulePump(delayMs = 1000): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump().catch(() => { this.options.logger?.write('error', 'scheduler.pump_failed'); }); }, delayMs);
    this.timer.unref();
  }
  private wakePump(): void {
    if (this.closed) return;
    if (this.pumpWork) { this.pumpAgain = true; return; }
    this.schedulePump(0);
  }
  private pump(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pumpWork) { this.pumpAgain = true; return this.pumpWork; }
    this.pumpAgain = false;
    const work = Promise.resolve().then(async () => {
      if (!this.closing && !this.chainPumpWork) {
        const chains = this.executionChains.pump().catch(() => { this.options.logger?.write('error', 'scheduler.chain_failed'); }).finally(() => { if (this.chainPumpWork === chains) this.chainPumpWork = undefined; });
        this.chainPumpWork = chains;
      }
      await this.scheduler.tick();
      // Plugin cleanup and input materialization must not hold up cancellation.
      void this.agentRouter?.releaseFinished().catch(() => { this.options.logger?.write('error', 'agent.cleanup_failed'); });
      if (this.closing && !this.active().length) this.finishClose();
    }).finally(() => {
      this.pumpWork = undefined;
      this.schedulePump(this.pumpAgain ? 0 : 1000);
    });
    this.pumpWork = work;
    return work;
  }
  async start(): Promise<void> {
    if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', 'Workspace closed');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.options.enableBackend && !this.options.backend) {
        await this.refreshModels().catch(() => { /* Catalog reads expose retryable errors. */ });
      }
      if (this.closed || this.closing) return;
      this.runs.retireImageRuns();
      await this.graphFiles.drain();
      if (!this.stopping) atomic(this.db, () => this.db.prepare("UPDATE settings SET value='true' WHERE key='acceptingRuns'").run());
      this.stopPumpSubscription = subscribeDatabaseChanges(this.db, () => this.wakePump());
      await this.pump();
      await this.chainPumpWork;
      await this.pump();
    })();
    return this.starting;
  }
  /** Host must hold its service-root instance lock before transferring epochs. */
  async recover(options: { start?: boolean } = {}): Promise<void> {
    if (this.closed || this.closing) throw new ServiceError('MAINTENANCE', 'Workspace closed');
    this.recovering = true;
    this.remoteAssets.recover();
    await this.remoteAssets.cleanStartupCaches();
    atomic(this.db, () => {
      this.runs.retireImageRuns();
      if (this.runs.repo.setting('backupRestorePending') === true) {
        this.db.prepare("DELETE FROM settings WHERE key='backupRestorePending'").run();
        this.runs.recover(this.scheduler.epoch);
      } else this.runs.abandonOnRestart(this.scheduler.epoch, run => {
        const selection = this.runs.snapshot(run.id).agent;
        if (!selection) return false;
        try { return !!this.options.agentRegistry?.get(selection.backendId).extensions?.restartRecovery; }
        catch { return true; }
      });
    });
    if (options.start !== false) await this.start();
  }
  /** Bind/startup failure only: never drain or mutate persisted service state. */
  disposeUnstarted(options: { allowPreparedRecovery?: boolean } = {}): void {
    this.visualizePreviews.close();
    if (this.starting || (this.recovering && !options.allowPreparedRecovery) || this.timer || !this.scheduler.isUnstarted || this.closing || this.stopping) throw new ServiceError('CONFLICT', 'Runtime has already entered its lifecycle');
    if (this.closed) return;
    this.remoteAssets.disposeUnstarted(); this.closed = true; this.executionChains.stop(); this.probe.close();
    this.agentConfiguration?.close();
    void this.agentDiscovery?.dispose().catch(() => {});
  }
  stopAccepting(): void { this.stopping = true; this.executionChains.stop(); atomic(this.db, () => this.db.prepare("UPDATE settings SET value='false' WHERE key='acceptingRuns'").run()); }
  /** A host shutdown cancels durable queued work as well as active responders. */
  stopRuns(): void {
    this.stopAccepting();
    for (const run of this.runs.unfinished()) {
      if (!isTerminalRunStatus(run.status)) this.runs.cancel(run.id, randomUUID(), 'host');
    }
  }
  async drain(options: { interrupt?: boolean } = {}): Promise<void> {
    this.stopAccepting();
    if (options.interrupt) this.remoteAssets.close();
    while (this.active().length) {
      if (options.interrupt) for (const run of this.active()) this.runs.cancel(run.id, 'runtime-drain', 'host');
      await this.pump(); await delay(25);
    }
    await this.remoteAssets.settled();
    await this.scheduler.settled();
    await this.chainPumpWork;
    await this.agentRouter?.disposeDrained();
  }
  private finishClose(): void {
    this.visualizePreviews.close();
    this.visualizeBridge.dispose();
    if (this.closed) return; this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.stopPumpSubscription?.(); this.stopPumpSubscription = undefined; this.probe.close();
    this.catalogRpc?.close();
    this.agentConfiguration?.close();
    void this.agentDiscovery?.dispose().catch(() => {});
    void this.agentRouter?.disposeDrained().catch(() => {});
    // No adapter.close(): disconnecting unresolved child processes is not cancellation.
  }
  close(): void {
    this.visualizePreviews.close();
    this.remoteAssets.close();
    if (this.closed) return; this.stopAccepting(); this.closing = true;
    if (!this.active().length) this.finishClose();
    else if (!this.timer) this.schedulePump(0);
  }
}
