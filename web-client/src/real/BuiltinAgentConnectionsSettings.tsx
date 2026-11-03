import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import type { BuiltinAgentConnection, BuiltinAgentConnectionConfiguration, BuiltinAgentDiscoveredModel, BuiltinAgentModel } from '../../../packages/protocol/src/builtin-agent';
import type { Request } from './contracts';
import { useI18n } from '../i18n/I18nProvider';
import { BuiltinAgentModelCombobox } from './BuiltinAgentModelCombobox';

const path = '/v1/agents/configuration/builtin/connections';
const openRouterEndpoint = 'https://openrouter.ai/api/v1';
const queryEndpoint = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.port === '0') return undefined;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return undefined; }
};
type ConnectionDraft = Omit<BuiltinAgentConnectionConfiguration, 'protocol'> & { protocol: BuiltinAgentConnectionConfiguration['protocol'] | 'openrouter' };
const blank = (): ConnectionDraft => ({ id: crypto.randomUUID(), name: '', protocol: 'responses', endpoint: 'https://api.openai.com/v1', enabled: true, models: [] });
const modelDraft = (id = '', catalog?: BuiltinAgentDiscoveredModel): BuiltinAgentModel => ({ id, name: id, tools: true, inputKinds: [...(catalog?.inputKinds ?? ['text'])], contextWindow: catalog?.contextWindow ?? null, reasoningEfforts: [...(catalog?.reasoningEfforts ?? [])] });
// OpenRouter is a form preset; persisted connections still use Responses.
const configuration = ({ revision: _revision, credentialConfigured: _configured, ...value }: BuiltinAgentConnection): ConnectionDraft => ({
  ...value, protocol: value.protocol === 'responses' && value.endpoint.replace(/\/+$/, '') === openRouterEndpoint ? 'openrouter' : value.protocol,
});
export interface BuiltinAgentConnectionsSettingsHandle { refresh(): Promise<void> }

/** Mounted exclusively inside AgentSettingsPanel. Authentication is write-only
 * and no idempotency key/storage journal is created for these settings calls. */
export function BuiltinAgentConnectionsSettings({ ref, request, disabled = false, onChanged, onBusyChange, onDirtyChange }: {
  ref?: Ref<BuiltinAgentConnectionsSettingsHandle>; request: Request; disabled?: boolean; onChanged?(): void; onBusyChange?(value: boolean): void; onDirtyChange?(value: boolean): void;
}) {
  const { language, t } = useI18n(), text = (zh: string, en: string) => language === 'zh-CN' ? zh : en;
  const id = useId(), errorRef = useRef<HTMLParagraphElement>(null);
  const [items, setItems] = useState<BuiltinAgentConnection[]>([]), [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(''), [draft, setDraft] = useState(blank);
  const [apiKey, setApiKey] = useState(''), [newModel, setNewModel] = useState('');
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [discovered, setDiscovered] = useState<BuiltinAgentDiscoveredModel[]>([]);
  const [pending, setPending] = useState<{ title: string; text: string; run(): void }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const selection = useRef<string | null>(null), loading = useRef<AbortController | null>(null);
  const current = items.find(item => item.id === selected), blocked = disabled || busy;
  const endpoint = queryEndpoint(draft.endpoint);
  const canDiscover = !!endpoint && (apiKey ? !!apiKey.trim() : !!current?.credentialConfigured && endpoint === queryEndpoint(current.endpoint));
  const dirty = !!apiKey || !!newModel || (current ? JSON.stringify(configuration(current)) !== JSON.stringify(draft) : !!draft.name || draft.models.length > 0 || draft.endpoint !== 'https://api.openai.com/v1' || draft.protocol !== 'responses' || !draft.enabled);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const refresh = useCallback(async () => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ items: BuiltinAgentConnection[] }>(path, undefined, 'GET', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems(result.items); setLoaded(true);
      // The parent handles unsaved-change confirmation before an explicit
      // refresh. Reset the form only after the fresh list arrives successfully.
      const item = selection.current === null ? result.items[0] : result.items.find(item => item.id === selection.current);
      selection.current = item?.id ?? ''; setSelected(selection.current); setDraft(item ? configuration(item) : blank());
      setApiKey(''); setNewModel(''); setDiscovered([]); setEditorGeneration(value => value + 1);
    } catch (value) {
      if (!controller.signal.aborted) { setLoaded(true); throw value; }
    } finally {
      if (loading.current === controller) { loading.current = null; setBusy(false); }
    }
  }, [request]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  useEffect(() => {
    let active = true;
    selection.current = null;
    void refresh().catch(value => { if (active) setError(value instanceof Error ? value.message : text('连接配置加载失败。', 'Could not load connections.')); });
    return () => { active = false; const controller = loading.current; loading.current = null; controller?.abort(); };
  }, [refresh]);
  const choose = (value: string) => {
    selection.current = value;
    const item = items.find(item => item.id === value); setSelected(value); setDraft(item ? configuration(item) : blank());
    setApiKey(''); setNewModel(''); setDiscovered([]); setEditorGeneration(value => value + 1); setError(''); setNotice('');
  };
  const changeConnection = (value: string) => {
    if (value === selected) return;
    if (dirty) setPending({ title: t('Discard unsaved changes'), text: t('Discard unsaved changes and continue?'), run: () => choose(value) });
    else choose(value);
  };
  const update = (value: BuiltinAgentConnection) => {
    selection.current = value.id;
    setItems(existing => existing.some(item => item.id === value.id) ? existing.map(item => item.id === value.id ? value : item) : [...existing, value]); setSelected(value.id); setDraft(configuration(value)); setEditorGeneration(value => value + 1);
  };
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (value) { setError(value instanceof Error ? value.message : text('连接操作失败。', 'Connection operation failed.')); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { setBusy(false); }
  };
  const save = async () => {
    let value = await request<BuiltinAgentConnection>(path, { ...draft, protocol: draft.protocol === 'openrouter' ? 'responses' : draft.protocol, expectedRevision: current?.revision ?? 0 });
    update(value);
    if (apiKey) {
      const key = apiKey; setApiKey('');
      value = await request<BuiltinAgentConnection>(path + '/' + value.id + '/credentials', { expectedRevision: value.revision, value: key });
      update(value);
    }
    setNotice(text('连接已保存。', 'Connection saved.')); onChanged?.();
  };
  const addModel = (value: string) => {
    const model = value.trim(); if (!model || draft.models.some(item => item.id === model)) return;
    setDraft(value => ({ ...value, models: [...value.models, modelDraft(model, discovered.find(item => item.id === model))] })); setNewModel('');
  };
  const editModel = (index: number, patch: Partial<BuiltinAgentModel>) => setDraft(value => ({ ...value, models: value.models.map((model, position) => position === index ? { ...model, ...patch } : model) }));
  return <fieldset className="agent-settings-subsection builtin-agent-connections" aria-labelledby={id + '-title'} disabled={blocked || !loaded}>
    <h4 className="agent-section-title" id={id + '-title'}>{text('供应商连接', 'Provider connections')}</h4>
    {!loaded && <p role="status">{text('正在加载连接…', 'Loading connections…')}</p>}
    <div className="builtin-agent-connection-picker">
      <label>{text('连接', 'Connection')}<select aria-label={text('连接', 'Connection')} value={selected} onChange={event => changeConnection(event.target.value)}>
        <option value="">{text('新增连接', 'New connection')}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" disabled={!selected} onClick={() => changeConnection('')}><Plus size={16} aria-hidden="true"/>{text('新增连接', 'New connection')}</button>
    </div>
    <form className="builtin-agent-connection-form" onSubmit={event => { event.preventDefault(); void action(save); }} onInvalidCapture={event => {
      const field = event.target as HTMLInputElement, details = field.closest('details');
      if (details) { details.open = true; requestAnimationFrame(() => field.focus()); }
    }}>
      <div className="agent-settings-fields">
        <label htmlFor={id + '-name'}>{text('连接名称', 'Connection name')}<input id={id + '-name'} required maxLength={150} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
        <label htmlFor={id + '-protocol'}>{text('API 协议', 'API protocol')}<select id={id + '-protocol'} aria-label={text('API 协议', 'API protocol')} value={draft.protocol} onChange={event => {
          const protocol = event.target.value as ConnectionDraft['protocol'];
          setDiscovered([]);
          setDraft({ ...draft, protocol, ...(protocol === 'openrouter' ? { endpoint: openRouterEndpoint } : {}) });
        }}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option><option value="openrouter">OpenRouter</option></select></label>
        {draft.protocol === 'chat-completions' && <label htmlFor={id + '-chat-provider'}>{text('Chat 兼容模式', 'Chat compatibility')}<select id={id + '-chat-provider'} aria-label={text('Chat 兼容模式', 'Chat compatibility')} value={draft.chatProvider ?? ''} onChange={event => {
          const { chatProvider: _provider, ...rest } = draft;
          setDraft(event.target.value ? { ...rest, chatProvider: event.target.value as NonNullable<BuiltinAgentConnectionConfiguration['chatProvider']> } : rest);
        }}><option value="">{text('自动（按 API 地址）', 'Automatic (by API URL)')}</option><option value="openai">{text('OpenAI 专用', 'OpenAI')}</option><option value="openai-compatible">{text('OpenAI 兼容', 'OpenAI compatible')}</option></select></label>}
        <label className="agent-field-wide" htmlFor={id + '-endpoint'}>{text('API 地址', 'API base URL')}<input id={id + '-endpoint'} type="url" required spellCheck={false} value={draft.endpoint} onChange={event => { setDiscovered([]); setDraft({ ...draft, endpoint: event.target.value }); }}/></label>
        <label className="agent-field-wide" htmlFor={id + '-key'}>{current?.credentialConfigured ? text('替换 API 密钥', 'Replace API key') : text('API 密钥', 'API key')}<input id={id + '-key'} type="password" autoComplete="new-password" spellCheck={false} placeholder={current?.credentialConfigured ? text('已配置，留空保留现有密钥', 'Configured; leave blank to keep the current key') : undefined} value={apiKey} onChange={event => { setDiscovered([]); setApiKey(event.target.value); }}/></label>
      </div>
      <label className="management-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })}/><span>{text('启用此连接', 'Enable this connection')}</span></label>
      <section className="builtin-agent-model-editor" aria-labelledby={id + '-models'}>
        <div className="agent-settings-toolbar">
          <h5 className="agent-section-title" id={id + '-models'}>{text('连接模型', 'Connection models')}</h5>
          <button type="button" disabled={!canDiscover} onClick={() => void action(async () => {
            const result = await request<{ models: BuiltinAgentDiscoveredModel[] }>(path + '/discover', {
              protocol: draft.protocol === 'openrouter' ? 'responses' : draft.protocol, endpoint: draft.endpoint,
              ...(apiKey ? { value: apiKey } : { id: current!.id, expectedRevision: current!.revision }),
            }); setDiscovered(result.models);
            if (!result.models.length) setNotice(text('未返回模型，仍可手动添加。', 'No models returned. You can still add a model manually.'));
          })}>{text('获取模型列表', 'Fetch model list')}</button>
        </div>
        <div className="builtin-agent-model-add">
          <label>{text('手动模型 ID', 'Manual model ID')}<input value={newModel} maxLength={128} onChange={event => setNewModel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModel(newModel); } }}/></label>
          <button type="button" disabled={!newModel.trim() || draft.models.some(model => model.id === newModel.trim())} onClick={() => addModel(newModel)}><Plus size={16} aria-hidden="true"/>{text('添加模型', 'Add model')}</button>
        </div>
        {discovered.length > 0 && <BuiltinAgentModelCombobox models={discovered.filter(model => !draft.models.some(item => item.id === model.id))} disabled={blocked} onAdd={addModel}/>}
        {!draft.models.length && <p className="agent-settings-empty">{text('尚未添加模型。添加后可设置名称与能力。', 'No models added. Add a model to configure its name and capabilities.')}</p>}
        {draft.models.map((model, index) => <details key={draft.id + '/' + model.id + '/' + editorGeneration} className="agent-model-provider" open={draft.models.length === 1}>
          <summary><ChevronRight size={16} aria-hidden="true"/><span className="builtin-agent-model-name"><strong>{model.name || model.id}</strong>{model.name && model.name !== model.id && <span>{model.id}</span>}</span></summary>
          <div className="builtin-agent-model-fields agent-settings-fields">
            <label>{text('模型名称', 'Model name')}<input required value={model.name} onChange={event => editModel(index, { name: event.target.value })}/></label>
            <label>{text('工具调用', 'Tool calling')}<select value={model.tools === null ? 'unknown' : String(model.tools)} onChange={event => editModel(index, { tools: event.target.value === 'unknown' ? null : event.target.value === 'true' })}><option value="unknown">{text('未知', 'Unknown')}</option><option value="true">{text('支持', 'Supported')}</option><option value="false">{text('不支持', 'Unsupported')}</option></select></label>
            <label>{text('上下文容量（Token）', 'Context capacity (tokens)')}<input type="number" min={4096} max={10000000} step={1} value={model.contextWindow ?? ''} onChange={event => editModel(index, { contextWindow: event.target.value ? Number(event.target.value) : null })}/></label>
            <label>{text('单次输出上限（含思考 Token）', 'Generation limit (including reasoning tokens)')}<input type="number" min={1024} max={393216} step={1} placeholder={text('自动', 'Automatic')} value={model.maxOutputTokens ?? ''} onChange={event => editModel(index, { maxOutputTokens: event.target.value ? Number(event.target.value) : null })}/></label>
            <div className="agent-field-wide builtin-agent-input-kinds" role="group" aria-label={text('模型输入类型', 'Model input types')}>{(['image', 'video', 'audio'] as const).map(kind => <label key={kind} className="management-checkbox"><input type="checkbox" checked={model.inputKinds.includes(kind)} onChange={event => editModel(index, { inputKinds: event.target.checked ? [...model.inputKinds, kind] : model.inputKinds.filter(value => value !== kind) })}/><span>{kind === 'image' ? text('支持图片输入', 'Supports image input') : kind === 'video' ? text('支持视频输入', 'Supports video input') : text('支持音频输入', 'Supports audio input')}</span></label>)}</div>
            <label className="agent-field-wide">{text('思考强度（逗号分隔）', 'Reasoning efforts (comma separated)')}<input defaultValue={model.reasoningEfforts.join(',')} onChange={event => editModel(index, { reasoningEfforts: event.target.value.split(',').map(value => value.trim()).filter(Boolean) })}/></label>
            <div className="agent-field-wide agent-settings-actions"><button className="agent-danger-button" type="button" onClick={() => setDraft(value => ({ ...value, models: value.models.filter((_, position) => position !== index) }))}><Trash2 size={16} aria-hidden="true"/>{text('移除模型', 'Remove model')}</button></div>
          </div>
        </details>)}
      </section>
      <div className="agent-settings-footer">
        <p className="agent-settings-hint">{text('保存此连接的认证信息和模型配置。', 'Save authentication and model settings for this connection.')}</p>
        {error && <p id={id + '-error'} role="alert" ref={errorRef} tabIndex={-1}>{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="agent-settings-actions">
          <button type="button" disabled={!dirty} onClick={() => setPending({ title: t('Discard unsaved changes'), text: t('Discard unsaved changes and continue?'), run: () => choose(selected) })}>{text('重置更改', 'Reset changes')}</button>
          <button className="primary-button" type="submit" aria-busy={busy}>{text('保存连接', 'Save connection')}</button>
        </div>
      </div>
    </form>
    {current && <details className="builtin-agent-connection-management">
      <summary>{text('管理此连接', 'Manage this connection')}</summary>
      <div className="agent-settings-actions"><button type="button" disabled={dirty || !current.credentialConfigured} onClick={() => setPending({ title: text('撤销认证', 'Revoke authentication'), text: text('撤销后，此连接需要重新配置密钥才能使用。', 'This connection will need a new API key before it can be used again.'), run: () => void action(async () => { update(await request<BuiltinAgentConnection>(path + '/' + current.id + '/revoke', { expectedRevision: current.revision })); setApiKey(''); onChanged?.(); }) })}>{text('撤销认证', 'Revoke authentication')}</button>
        <button className="agent-danger-button" type="button" disabled={dirty} onClick={() => setPending({ title: text('删除连接', 'Delete connection'), text: text('删除此连接及其模型配置？此操作无法撤销。', 'Delete this connection and its model settings? This cannot be undone.'), run: () => void action(async () => { await request(path + '/' + current.id + '/delete', { expectedRevision: current.revision }); setItems(value => value.filter(item => item.id !== current.id)); choose(''); onChanged?.(); }) })}><Trash2 size={16} aria-hidden="true"/>{text('删除连接', 'Delete connection')}</button></div>
    </details>}
    {pending && <ConfirmationDialog title={pending.title} text={pending.text} disabled={blocked} onCancel={() => setPending(undefined)} onConfirm={() => { const next = pending.run; setPending(undefined); next(); }}/>}
  </fieldset>;
}
