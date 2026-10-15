import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, RefreshCw, Trash2 } from 'lucide-react';
import type { AgentBackendConfiguration, AgentPlatform, AgentConfigurationUpdate } from '../../../packages/protocol/src/agents';
import { AgentConfigurationForm } from './AgentConfigurationForm';
import { agentModelKey, initialEffort, orderedAgents, useWorkspaceAgents, workspaceAgentDefault, type WorkspaceAgentStore } from './agent-state';
import { useI18n } from '../i18n/I18nProvider';
import './AgentSettingsPanel.css';
import { AgentMark } from './AgentMark';
import { backendConfigurationFields, type BackendConfigurationFields } from './agent-settings-fields';

/** New configuration sections use an independent gateway, never old settings keys. */
export function AgentSettingsPanel({ store, readOnly = false, onChanged, onReady, onBusyChange }: {
  store: WorkspaceAgentStore; readOnly?: boolean; onChanged?: () => void; onReady?: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const state = useWorkspaceAgents(store);
  const [selected, setSelected] = useState('');
  const [sortMode, setSortMode] = useState(false);
  const [editing, setEditing] = useState<{ backendId: string; settings: AgentBackendConfiguration; value: BackendConfigurationFields }>();
  const [order, setOrder] = useState<string[]>();
  const [defaultSelection, setDefaultSelection] = useState<{ backendId: string; model: { model: string; reasoningEffort: string | null } }>();
  const [permission, setPermission] = useState<'read-only' | 'workspace-write' | 'danger-full-access'>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const agents = orderedAgents(state), backend = state.descriptors.find(item => item.id === selected) ?? agents[0];
  const resource = backend && state.resources[backend.id], settings = resource?.settings;
  const fields = editing && editing.backendId === backend?.id && editing.settings === settings ? editing.value
    : settings ? backendConfigurationFields(settings, resource?.models?.map(model => ({ id: model.id, visible: false })) ?? []) : undefined;
  const configuration = state.configuration;
  const platform = configuration?.platform;
  const unsupportedPlatform = !!platform && !!backend?.capabilities.platforms && !backend.capabilities.platforms.includes(platform as AgentPlatform);
  const backendUnsupported = unsupportedPlatform || resource?.modelsUnsupported;
  const platformNames: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const unsupportedReason = unsupportedPlatform
    ? text(`${backend.name} 不支持当前工作空间的 ${platformNames[platform!] ?? platform} 平台。`, `${backend.name} does not support the Workspace’s ${platformNames[platform!] ?? platform} platform.`)
    : text('当前 Agent 不支持模型目录查询，暂无法配置。', 'This Agent does not support model catalog queries, so configuration is unavailable.');
  const configurationSupported = !!configuration;
  const chosen = defaultSelection ?? workspaceAgentDefault(state);
  const chosenBackend = configuration?.backends.find(item => item.backendId === chosen?.backendId);
  const onboardingDefaultBlocked = !!onReady && !(chosenBackend && chosenBackend.revision > 0 && chosenBackend.schemaVersion > 0);
  const chosenModel = chosen && state.resources[chosen.backendId]?.models?.find(item => item.id === chosen.model.model);
  const disabled = readOnly || busy;
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { if (!selected && backend) setSelected(backend.id); }, [selected, backend?.id]);
  useEffect(() => { setEditing(undefined); }, [backend?.id, settings]);
  useEffect(() => {
    setPermission(undefined); setOrder(undefined); setDefaultSelection(undefined);
  }, [configuration]);
  useEffect(() => {
    setEditing(current => {
      if (!current || current.backendId !== backend?.id || current.settings !== settings) return current;
      const added = (resource?.models ?? []).filter(model => !current.value.models.some(item => item.id === model.id)).map(model => ({ id: model.id, visible: false }));
      return added.length ? { ...current, value: { ...current.value, models: [...current.value.models, ...added] } } : current;
    });
  }, [resource?.models]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  async function save(work: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(success); onChanged?.(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); await store.refresh(); }
    finally { setBusy(false); }
  }
  const saveBackend = async (options = fields?.options) => {
    if (!backend || !fields || !options || !settings) return;
    const update: AgentConfigurationUpdate = { section: 'backend', backendId: backend.id, expectedRevision: settings.revision, schemaVersion: settings.schemaVersion,
      enabled: fields.enabled, options, models: fields.models };
    await store.saveConfiguration(update);
    setEditing(undefined);
  };
  const update = (value: Partial<BackendConfigurationFields>) => { if (backend && settings && fields) setEditing({ backendId: backend.id, settings, value: { ...fields, ...value } }); };
  const move = (id: string, delta: number) => {
    const next = [...(order ?? agents.map(item => item.id))], index = next.indexOf(id), target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; setOrder(next);
  };
  if (state.mode === 'legacy') return null;
  return <section className="management-section agent-settings" aria-label={text('Agent 设置', 'Agent settings')}>
    {state.mode === 'loading' && <p role="status">{text('正在加载 Agent…', 'Loading Agents…')}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    <div className="agent-settings-toolbar agent-settings-intro"><span>{text('配置运行权限与可用模型', 'Configure permissions and available models')}</span><button type="button" disabled={busy} onClick={() => void save(store.refresh, text('Agent 目录已刷新。', 'Agent catalog refreshed.'))}><RefreshCw size={16} aria-hidden="true"/>{text('刷新 Agent 目录', 'Refresh Agent catalog')}</button></div>
    {configuration?.default.selection && !state.descriptors.some(item => item.id === configuration.default.selection!.backendId) && <p role="alert">{text('已保存默认 Agent 不可用，请明确重选。', 'The saved default Agent is unavailable. Choose another explicitly.')}</p>}
    {state.configurationError && <p role="alert">{state.configurationError}</p>}
    {error && <p role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <fieldset className="agent-settings-section" disabled={disabled || !configurationSupported}><legend>{text('公共权限', 'Shared permissions')}</legend>
      <label>{text('项目目录权限', 'Project directory permissions')}<select aria-label={text('项目目录权限', 'Project directory permissions')} value={permission ?? configuration?.permissions.project ?? 'workspace-write'} onChange={event => { setPermission(event.target.value as NonNullable<typeof permission>); }}>
        <option value="read-only">{text('只读', 'Read-only')}</option><option value="workspace-write">{text('可写', 'Workspace write')}</option><option value="danger-full-access">{text('完全访问', 'Full access')}</option>
      </select></label>
      <p>{text('所有 Agent 共用；任务输入、输出与临时目录保持可读写。已接受任务沿用冻结权限。', 'Shared by all Agents. Run inputs, outputs and temporary directories remain writable. Accepted runs keep their frozen permissions.')}</p>
      {state.descriptors.filter(item => item.projectPermissionModes && !item.projectPermissionModes.includes(permission ?? configuration?.permissions.project ?? 'workspace-write')).map(item => <p key={item.id} role="status">{item.name} · {text('不支持此项目权限模式；模型目录仍可管理，运行前需调整权限或选择其他 Agent。', 'This project permission mode is unsupported. You can manage models; change permissions or choose another Agent before running.')}</p>)}
      <button type="button" disabled={!permission} onClick={() => void save(async () => { await store.saveConfiguration({ section: 'permissions', expectedRevision: configuration!.permissions.revision, project: permission! }); setPermission(undefined); }, text('公共权限已保存。', 'Shared permissions saved.'))}>{text('保存公共权限', 'Save shared permissions')}</button>
    </fieldset>
    <div className="agent-settings-section agent-editor">
    <div className="agent-settings-toolbar"><h3>{text('Agent 与模型', 'Agents and models')}</h3><button type="button" disabled={disabled || !configurationSupported} aria-pressed={sortMode} onClick={() => setSortMode(value => !value)}>{text('调整 Agent 顺序', 'Reorder Agents')}</button></div>
    <div className="agent-backend-list" role="group" aria-label={text('Agent 模型管理', 'Agent model management')}>
      {(order ?? agents.map(item => item.id)).map((id, index, list) => {
        const item = state.descriptors.find(entry => entry.id === id); if (!item) return null;
        const savedBackend = configuration?.backends.find(item => item.backendId === id);
        const configured = !!savedBackend && savedBackend.revision > 0 && savedBackend.schemaVersion > 0;
        return <div key={id} className="agent-backend-row" draggable={sortMode && !disabled && configurationSupported} onDragStart={event => event.dataTransfer.setData('application/x-openworkgraph-agent', id)} onDragOver={event => { if (sortMode && !disabled) event.preventDefault(); }} onDrop={event => {
          event.preventDefault(); if (disabled || !sortMode) return;
          const dragged = event.dataTransfer.getData('application/x-openworkgraph-agent');
          const current = order ?? agents.map(item => item.id); if (!current.includes(dragged) || dragged === id) return;
          const next = current.filter(item => item !== dragged); next.splice(next.indexOf(id), 0, dragged);
          setOrder(next);
        }}><button type="button" aria-pressed={backend?.id === id} onClick={() => setSelected(id)}><AgentMark descriptor={item}/><span className="agent-backend-name">{item.name}</span>{configured && <span className="agent-configured"><Check size={16} aria-hidden="true"/>{text('已配置', 'Configured')}</span>}{state.resources[id]?.settings?.enabled === false && <span>{text('已停用', 'Disabled')}</span>}</button>
          <button type="button" aria-label={text('上移 ', 'Move up ') + item.name} hidden={!sortMode} disabled={disabled || !sortMode || !configurationSupported || index === 0} onClick={() => move(id, -1)}><ArrowUp size={16}/></button>
          <button type="button" aria-label={text('下移 ', 'Move down ') + item.name} hidden={!sortMode} disabled={disabled || !sortMode || !configurationSupported || index === list.length - 1} onClick={() => move(id, 1)}><ArrowDown size={16}/></button>
        </div>;
      })}
      {(sortMode || order) && <button type="button" disabled={disabled || !configurationSupported || !order} onClick={() => void save(async () => { await store.saveConfiguration({ section: 'order', backendIds: order!, expectedRevision: configuration!.order.revision }); setOrder(undefined); }, text('Agent 顺序已保存。', 'Agent order saved.'))}>{text('保存顺序', 'Save order')}</button>}
    </div>
    {backend && <>
      {backendUnsupported ? <p role="alert">{text('执行器不支持此操作。', 'The executor does not support this operation.')}<br/>{unsupportedReason}</p>
        : (resource?.settingsError || resource?.modelsError) && <p role="alert">{resource.settingsError ?? resource.modelsError}</p>}
      {!backendUnsupported && !settings && !resource?.settingsError && <p role="status">{text('正在加载插件配置…', 'Loading plugin settings…')}</p>}
      {!backendUnsupported && fields && settings && <>
        <label className="management-checkbox"><input type="checkbox" disabled={disabled} checked={fields.enabled} onChange={event => update({ enabled: event.target.checked })}/><span>{text('启用 ', 'Enable ') + backend.name}</span></label>
        <details className="agent-native-settings" open={onReady ? true : undefined}>
          <summary><span>{text('原生配置', 'Native configuration')}</span><ChevronDown size={16} aria-hidden="true"/></summary>
        {configuration?.platform ? <AgentConfigurationForm descriptor={backend} platform={configuration.platform as AgentPlatform} value={fields.options} disabled={disabled} onChange={options => update({ options })} onSubmit={value => void save(async () => {
          await saveBackend(value.options);
        }, text('插件配置已保存。', 'Plugin settings saved.'))}/> : <p role="status">{text('工作空间未提供设备平台，暂不能编辑原生选项。模型管理仍可保存。', 'The Workspace did not report its device platform. Native option editing is unavailable; model management can still be saved.')}</p>}
        </details>
        <fieldset className="agent-model-settings" disabled={disabled || !configurationSupported}><legend>{text('模型可见性', 'Model visibility')}</legend>
          {backend.models.allowCustom && <label>{text('手动模型 ID', 'Custom model ID')}<input aria-label={text('手动模型 ID', 'Custom model ID')} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); const id = event.currentTarget.value.trim(); if (id && !fields.models.some(model => model.id === id)) update({ models: [...fields.models, { id, visible: true }] }); event.currentTarget.value = ''; } }}/><span>{text('按 Enter 添加', 'Press Enter to add')}</span></label>}

          <div className="management-actions"><button type="button" onClick={() => update({ models: fields.models.map(model => ({ ...model, visible: true })) })}>{text('全部显示', 'Show all')}</button><button type="button" onClick={() => update({ models: fields.models.map(model => ({ ...model, visible: false })) })}>{text('全部隐藏', 'Hide all')}</button></div>
          <div className="agent-model-list">{fields.models.map(model => {
            const absent = resource?.models && !resource.models.some(item => item.id === model.id) && !resource.modelsError;
            const manual = absent && backend.models.allowCustom && !resource?.knownModelIds?.includes(model.id);
            return <div className="agent-model-row" key={model.id}>
              <label className="management-checkbox"><input type="checkbox" aria-label={model.id} checked={model.visible} onChange={event => update({ models: fields.models.map(item => item.id === model.id ? { ...item, visible: event.target.checked } : item) })}/><span>{model.id}{!settings.models.some(saved => saved.id === model.id) && text('（尚未保存）', ' (unsaved)')}{absent && (manual ? text('（手动 ID）', ' (custom ID)') : text('（已下架）', ' (unavailable)'))}</span></label>
              {manual && <button type="button" aria-label={text('删除模型 ', 'Delete model ') + model.id} onClick={() => update({ models: fields.models.filter(item => item.id !== model.id) })}><Trash2 size={16} aria-hidden="true"/>{text('删除', 'Delete')}</button>}
            </div>;
          })}</div>
          <button type="button" onClick={() => void save(async () => {
            await saveBackend();
          }, text('Agent 配置已保存。', 'Agent configuration saved.'))}>{text('保存Agent配置', 'Save Agent configuration')}</button>
        </fieldset>
      </>}
    </>}
    </div>
    <fieldset className="agent-settings-section" disabled={disabled || !configurationSupported}><legend>{text('工作空间默认模型', 'Workspace default model')}</legend>
      {onboardingDefaultBlocked && <p role="status">{text('请先保存所选 Agent 的模型配置，再保存工作空间默认。', 'Save the selected Agent model configuration before saving the Workspace default.')}</p>}
      <label>{text('Agent / 模型', 'Agent / model')}<select aria-label={text('Agent / 模型', 'Agent / model')} value={chosen ? agentModelKey(chosen.backendId, chosen.model.model) : ''} onChange={event => {
        const [backendId, modelId] = JSON.parse(event.target.value) as [string, string];
        const model = state.resources[backendId]?.models?.find(item => item.id === modelId);
        if (model || state.descriptors.find(item => item.id === backendId)?.models.allowCustom) setDefaultSelection({ backendId, model: { model: modelId, reasoningEffort: model ? initialEffort(model) : null } });
      }}><option value="" disabled>{text('选择模型', 'Choose a model')}</option>{chosen && !configuration?.backends.find(item => item.backendId === chosen.backendId)?.models.some(item => item.id === chosen.model.model) && <option value={agentModelKey(chosen.backendId, chosen.model.model)}>{chosen.backendId} · {chosen.model.model} ({text('未保存或不可用', 'unsaved or unavailable')})</option>}{agents.map(item => <optgroup key={item.id} label={item.name}>{configuration?.backends.find(entry => entry.backendId === item.id)?.models.map(model => <option key={model.id} value={agentModelKey(item.id, model.id)}>{item.name} · {model.id}{!model.visible && text('（隐藏）', ' (hidden)')}</option>)}</optgroup>)}</select></label>
      <label>{text('思考强度', 'Reasoning effort')}<select aria-label={text('思考强度', 'Reasoning effort')} value={chosen?.model.reasoningEffort ?? ''} onChange={event => { if (chosen) setDefaultSelection({ ...chosen, model: { ...chosen.model, reasoningEffort: event.target.value || null } }); }}><option value="">{text('使用原生默认', 'Use native default')}</option>{chosenModel?.reasoningEfforts.map(value => <option key={value}>{value}</option>)}</select></label>
      <button type="button" disabled={onboardingDefaultBlocked || !chosen || !chosenModel && !state.descriptors.find(item => item.id === chosen.backendId)?.models.allowCustom} onClick={() => void save(async () => { await store.saveConfiguration({ section: 'default', expectedRevision: configuration!.default.revision, selection: { backendId: chosen!.backendId, ...chosen!.model } }); setDefaultSelection(undefined); onReady?.(); }, text('工作空间默认模型已保存。', 'Workspace default model saved.'))}>{text('保存默认模型', 'Save default model')}</button>
    </fieldset>

  </section>;
}
