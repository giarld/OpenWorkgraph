import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpCircle, BookOpen, CheckCircle2, ChevronRight, Circle, Download, RefreshCw, Search, Settings2, TriangleAlert, X } from 'lucide-react';
import type { SkillCatalog, SkillCatalogItem, SkillConfiguration, SkillDetail } from '../../../packages/protocol/src/skills';
import type { Transport } from '../adapter/transport';
import { isLifecycleCancellation } from '../adapter/transport';
import { useI18n } from '../i18n/I18nProvider';
import { skillConfigPatch, missingSkillFields, skillFieldCopy, type SkillFieldEdit } from './skill-library-state';
import { SkillReadme } from './SkillReadme';
import '../components/content.css';
import './SkillsLibrary.css';

type SkillClient = Pick<Transport, 'listSkills' | 'skillDetail' | 'installSkill' | 'updateSkill' | 'uninstallSkill' | 'readSkillConfig' | 'writeSkillConfig' | 'clearSkillConfig'> & Partial<Pick<Transport, 'readSkillFile'>>;
type Copy = (english: string, chinese: string) => string;
const notifySkillsChanged = () => window.dispatchEvent(new Event('openworkgraph:skills-changed'));
function errorText(error: unknown, copy: Copy): string {
  if (isLifecycleCancellation(error)) return copy('Workspace connection changed. Reload to continue.', '工作空间连接已改变，请重新加载。');
  return error instanceof Error ? error.message : copy('Request failed. Check the Workspace connection and retry.', '请求失败，请检查工作空间连接后重试。');
}
function configError(error: unknown, copy: Copy): string {
  // Never echo user-entered secrets, including values in unexpected error responses.
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return copy('Configuration request failed. Reload the settings and retry.', '配置请求失败，请重新加载设置后重试。') + (/^[A-Z_]+$/.test(code) ? ' (' + code + ')' : '');
}
function SkillDialog({ title, workspaceName, onClose, children, copy, readme = false }: { title: string; workspaceName: string; onClose(): void; children: ReactNode; copy: Copy; readme?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    return () => { element.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className={"ow-skills-dialog" + (readme ? " ow-skills-readme-dialog" : "")} aria-labelledby={titleId}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={event => { event.preventDefault(); closeRef.current(); }}>
    <header><div><small>{copy('Workspace', '工作空间')} · {workspaceName}</small><h2 id={titleId}>{title}</h2></div>
      <button type="button" autoFocus aria-label={copy('Close', '关闭')} onClick={onClose}><X size={18} aria-hidden="true"/></button></header>
    {children}
  </dialog>, document.body);
}

export function SkillsLibrary({ transport, ready, workspaceName, visible = true }: { transport?: SkillClient; ready: boolean; workspaceName: string; visible?: boolean }) {
  const { language, locale } = useI18n();
  const copy: Copy = (en, zh) => language === 'zh-CN' ? zh : en;
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const library = useRef<HTMLElement>(null);
  const moreSentinel = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ id: string; action: 'install' | 'update' | 'uninstall' }>();
  const [modal, setModal] = useState<{ item: SkillCatalogItem; mode: 'detail' | 'config' }>();
  const [confirmUninstall, setConfirmUninstall] = useState<SkillCatalogItem>();
  const scope = useRef(0);
  const loadSequence = useRef(0);
  const mutation = useRef(false);
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const catalogOwner = useRef({ transport, query, installedOnly });
  const catalogSnapshot = useRef<SkillCatalog | undefined>(undefined);
  const listsInFlight = useRef(0);
  const load = useCallback(async (refresh = false, append = false, preserve = false) => {
    if (!transport || !ready || (append && (listsInFlight.current > 0 || mutation.current))) return;
    const previous = catalogSnapshot.current;
    if (append && (installedOnly || previous?.nextOffset === undefined)) return;
    const epoch = scope.current;
    const sequence = ++loadSequence.current;
    listsInFlight.current++;
    if (append) { setLoadingMore(true); setMoreError(''); }
    else { setLoading(true); setError(''); setMoreError(''); }
    try {
      const target = preserve ? previous?.items.length ?? 100 : 100;
      let offset = append ? previous!.nextOffset! : 0;
      let result: SkillCatalog;
      let rows: SkillCatalogItem[] = [];
      do {
        result = await transport.listSkills(refresh && offset === 0, installedOnly ? { installedOnly: true, query } : { offset, limit: offset === 0 ? 100 : 50, query });
        if (epoch !== scope.current || sequence !== loadSequence.current) return;
        rows.push(...result.items);
        // Refresh the loaded range after operations without collapsing the list.
        if (installedOnly || append || !preserve || result.nextOffset === undefined || rows.length >= target) break;
        if (result.nextOffset <= offset) throw Error('Invalid skill pagination');
        offset = result.nextOffset;
      } while (true);
      const signature = (catalog: SkillCatalog) => JSON.stringify(catalog.items.filter(item => item.installed).map(item => [item.skillId, item.packageVersion, item.revision, item.configuration]).sort());
      if (!append && previous && (previous.installedSignature !== result.installedSignature || signature(previous) !== signature({ ...result, items: rows }))) notifySkillsChanged();
      const items = [...new Map((append ? [...previous!.items, ...rows] : rows).map(item => [item.skillId, item])).values()];
      const next = { ...result, items };
      catalogSnapshot.current = next; setCatalog(next); setError('');
    } catch (error) {
      if (epoch === scope.current && sequence === loadSequence.current) {
        if (append) setMoreError(errorText(error, copyRef.current));
        else setError(errorText(error, copyRef.current));
      }
    } finally {
      if (epoch === scope.current) listsInFlight.current--;
      if (epoch === scope.current && sequence === loadSequence.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [transport, ready, installedOnly, query]);
  useEffect(() => {
    scope.current++; setModal(undefined); setConfirmUninstall(undefined); setPending(undefined); mutation.current = false;
    listsInFlight.current = 0;
    setLoading(false); setLoadingMore(false); setMoreError('');
    const owner = catalogOwner.current;
    if (owner.transport !== transport || owner.query !== query || owner.installedOnly !== installedOnly) {
      catalogOwner.current = { transport, query, installedOnly };
      catalogSnapshot.current = undefined; setCatalog(undefined); setError('');
      // Reset the actual scroll host (the sidebar in the app, the panel when standalone).
      for (let host = library.current; host; host = host.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(host).overflowY) && host.scrollHeight > host.clientHeight) { host.scrollTop = 0; break; }
      }
    }
    void load(false, false, true);
    return () => { scope.current++; loadSequence.current++; };
  }, [load]);
  useEffect(() => {
    const sentinel = moreSentinel.current;
    if (!sentinel || !visible || !ready || loading || loadingMore || moreError || error || pending || installedOnly || catalog?.nextOffset === undefined) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void load(false, true);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visible, ready, loading, loadingMore, moreError, error, pending, installedOnly, catalog, load]);
  useEffect(() => { if (!visible) { setModal(undefined); setConfirmUninstall(undefined); } }, [visible]);
  const operate = async (item: SkillCatalogItem, action: 'install' | 'update' | 'uninstall') => {
    if (!transport || !ready || mutation.current) return;
    const epoch = scope.current;
    mutation.current = true; ++loadSequence.current; setLoading(false); setLoadingMore(false); setPending({ id: item.skillId, action }); setError('');
    try {
      const result = await (action === 'install' ? transport.installSkill(item.skillId, item.revision) : action === 'update' ? transport.updateSkill(item.skillId, item.revision) : transport.uninstallSkill(item.skillId, item.revision));
      notifySkillsChanged();
      if (epoch !== scope.current) return;
      setCatalog(previous => previous ? { ...previous, items: previous.items.map(row => row.skillId === result.skillId ? result : row) } : { items: [result], stale: false });
      void load(false, false, true);
    } catch (error) { if (epoch === scope.current) setError(errorText(error, copy)); }
    finally { if (epoch === scope.current) { mutation.current = false; setPending(undefined); } }
  };
  const items = catalog?.items.filter(item => (!installedOnly || item.installed) && (item.name + ' ' + item.description).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <section ref={library} className="ow-skills-library" aria-label={copy('Skill library', '技能库')}>
    {!transport ? <p className="ow-skills-empty">{copy('Select and connect a Workspace to browse skills.', '选择并连接工作空间后即可查看技能库。')}</p> : <>
      <div className="ow-skills-controls">
        <label className="ow-skills-search"><Search size={15} aria-hidden="true"/><input type="search" aria-label={copy('Search skills', '搜索技能')} value={query} onChange={event => setQuery(event.target.value)} placeholder={copy('Search name or description', '搜索名称或简介')}/>{query && <button className="ow-skills-clear" type="button" aria-label={copy('Clear skill search', '清除技能搜索')} onClick={() => setQuery('')}><X size={14} aria-hidden="true"/></button>}</label>
        <div className="ow-skills-toolbar">
          <div className="ow-skills-filter" role="group" aria-label={copy('Skill filter', '技能筛选')}><button type="button" aria-pressed={!installedOnly} onClick={() => setInstalledOnly(false)}>{copy('All', '全部')}</button><button type="button" aria-pressed={installedOnly} onClick={() => setInstalledOnly(true)}>{copy('Installed', '已安装')}</button></div>
          <button className="ow-skills-refresh" type="button" disabled={!ready || !transport || loading || !!pending} aria-label={copy('Refresh skills', '刷新技能')} onClick={() => void load(true)}><RefreshCw size={16} aria-hidden="true"/></button>
        </div>
        <small className="ow-skills-workspace">{copy('Workspace', '工作空间')} · {workspaceName || copy('Not connected', '未连接')}</small>
      </div>
      {!ready && <p role="status">{copy('Workspace is disconnected. Reconnect to manage skills.', '工作空间已断开，重新连接后可管理技能。')}</p>}
      {loading && <p role="status">{copy('Loading skills…', '正在加载技能…')}</p>}
      {(error || catalog?.error || catalog?.stale) && <div className="ow-skills-error" role="alert"><p>{error || catalog?.error || copy('Showing cached skills. Refresh to check the source.', '正在显示缓存技能，请刷新以检查来源。')}</p><button type="button" disabled={!ready || loading || !!pending} onClick={() => void load(true)}>{copy('Reload and retry', '重新加载并重试')}</button></div>}
      {!loading && catalog && !items.length && !error && !catalog.error && !catalog.stale && <p className="ow-skills-empty">{query || installedOnly ? copy('No matching skills.', '没有匹配的技能。') : copy('No skills in this source.', '此来源暂无技能。')}</p>}
      <ul className="ow-skills-list" aria-busy={loading || loadingMore}>{items.map(item => <li key={item.skillId}>
        <button className="ow-skills-open" type="button" aria-label={item.name} aria-haspopup="dialog" disabled={!ready || !!pending} onClick={() => setModal({ item, mode: 'detail' })}/>
        <h3 className="ow-skills-title"><BookOpen size={16} aria-hidden="true"/><span>{item.name}</span><ChevronRight size={14} className="ow-skills-chevron" aria-hidden="true"/></h3>
        <p>{item.description}</p><small>{item.source.repository} · {item.directory}</small>
        <div className="ow-skills-badges">
          <span className={item.installed ? 'ow-skills-status is-success' : 'ow-skills-status'}>{item.installed ? <CheckCircle2 size={13} aria-hidden="true"/> : <Circle size={13} aria-hidden="true"/>}{item.installed ? copy('Installed', '已安装') : copy('Not installed', '未安装')}</span>
          {item.updateAvailable && <span className="ow-skills-status is-update"><ArrowUpCircle size={13} aria-hidden="true"/>{copy('Update available', '可更新')}</span>}
          <span className={item.configuration === 'required' ? 'ow-skills-status is-warning' : 'ow-skills-status'}>{item.configuration === 'required' ? <TriangleAlert size={13} aria-hidden="true"/> : item.configuration === 'ready' ? <CheckCircle2 size={13} aria-hidden="true"/> : null}{item.configuration === 'required' ? copy('Configuration required', '待配置') : item.configuration === 'ready' ? copy('Configured', '已配置') : copy('No configuration', '无需配置')}</span>
        </div>
        {item.error && <p role="alert">{item.error}</p>}
        {pending?.id === item.skillId && <p role="status">{pending.action === 'install' ? copy('Installing…', '正在安装…') : pending.action === 'update' ? copy('Updating…', '正在更新…') : copy('Uninstalling…', '正在卸载…')}</p>}
        <div className="ow-skills-actions">{item.installed ? <>
          <button type="button" disabled={!ready || !!pending} onClick={() => setModal({ item, mode: 'config' })}><Settings2 size={14} aria-hidden="true"/>{copy('Settings', '设置')}</button>
          {item.updateAvailable && <button className="ow-skills-primary" type="button" disabled={!ready || !!pending || !!item.error} onClick={() => void operate(item, 'update')}><RefreshCw size={14} aria-hidden="true"/>{copy('Update', '更新')}</button>}
          <button className="ow-skills-remove" type="button" disabled={!ready || !!pending} onClick={() => setConfirmUninstall(item)}>{copy('Uninstall', '卸载')}</button>
        </> : <button className="ow-skills-primary" type="button" disabled={!ready || !!pending || !!item.error} onClick={() => void operate(item, 'install')}><Download size={14} aria-hidden="true"/>{copy('Install', '安装')}</button>}</div>
      </li>)}</ul>
      {!installedOnly && catalog?.nextOffset !== undefined && <div ref={moreSentinel} className="ow-skills-more">
        {loadingMore ? <p role="status">{copy('Loading more skills…', '正在加载更多技能…')}</p> : <>
          {moreError && <p role="alert">{moreError}</p>}
          <button type="button" disabled={!ready || loading || !!pending} onClick={() => void load(false, true)}>{moreError ? copy('Retry loading more', '重试加载更多') : copy('Load more', '加载更多')}</button>
        </>}
      </div>}
      <p className="ow-skills-note">{copy('Skills are shared by all projects in this Workspace. Automatic use loads configuration as needed. Uninstalling keeps saved configuration.', '技能供此工作空间的所有项目共用。自动使用时按需加载配置。卸载会保留已保存的配置。')}</p>
    </>}
    {modal && transport && ready && visible && <SkillContents key={modal.item.skillId + ':' + modal.mode + ':' + locale} item={modal.item} mode={modal.mode} client={transport} locale={locale} copy={copy} workspaceName={workspaceName} onClose={() => setModal(undefined)} onChanged={() => { void load(false, false, true); }}/>}
    {confirmUninstall && ready && <SkillDialog title={copy('Uninstall skill', '卸载技能')} workspaceName={workspaceName} copy={copy} onClose={() => setConfirmUninstall(undefined)}>
      <p>{copy('Uninstall', '卸载')} {confirmUninstall.name}？{copy('Saved configuration is retained.', '已保存的配置会保留。')}</p><footer><button type="button" onClick={() => setConfirmUninstall(undefined)}>{copy('Cancel', '取消')}</button><button type="button" onClick={() => { const item = confirmUninstall; setConfirmUninstall(undefined); void operate(item, 'uninstall'); }}>{copy('Uninstall', '卸载')}</button></footer>
    </SkillDialog>}
  </section>;
}

function SkillContents({ item, mode, client, locale, copy, workspaceName, onClose, onChanged }: { item: SkillCatalogItem; mode: 'detail' | 'config'; client: SkillClient; locale: string; copy: Copy; workspaceName: string; onClose(): void; onChanged(): void }) {
  const [detail, setDetail] = useState<SkillDetail>();
  const [config, setConfig] = useState<SkillConfiguration>();
  const [edits, setEdits] = useState<Record<string, SkillFieldEdit>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const lifetime = useRef(0);
  const saveLock = useRef(false);
  useEffect(() => {
    const epoch = ++lifetime.current;
    setLoading(true); setError(''); setConfig(undefined); setDetail(undefined); setEdits({}); setConfirmClear(false);
    const request = mode === 'detail' ? client.skillDetail(item.skillId, locale) : client.readSkillConfig(item.skillId);
    void request.then(result => { if (epoch !== lifetime.current) return; if (mode === 'detail') setDetail(result as SkillDetail); else setConfig(result as SkillConfiguration); })
      .catch(error => { if (epoch === lifetime.current) setError(mode === 'config' ? configError(error, copy) : errorText(error, copy)); })
      .finally(() => { if (epoch === lifetime.current) setLoading(false); });
    return () => { lifetime.current++; };
  }, [client, item.skillId, locale, mode, reload]);
  const save = async (clear = false) => {
    if (!config || saveLock.current) return;
    const epoch = lifetime.current;
    saveLock.current = true; setSaving(true); setError('');
    try {
      if (clear) await client.clearSkillConfig(item.skillId, config.revision);
      else {
        if (!config.packageVersion) throw new Error('Missing package version');
        await client.writeSkillConfig(item.skillId, config.revision, skillConfigPatch(edits), config.packageVersion);
      }
      notifySkillsChanged();
      if (epoch !== lifetime.current) return;
      setEdits({}); onChanged(); onClose();
    } catch (error) { if (epoch === lifetime.current) setError(configError(error, copy)); }
    finally { if (epoch === lifetime.current) { saveLock.current = false; setSaving(false); } }
  };
  const missing = config ? missingSkillFields(config, edits) : [];
  return <SkillDialog readme={mode === 'detail'} title={item.name + (mode === 'config' ? ' · ' + copy('Settings', '设置') : '')} workspaceName={workspaceName} copy={copy} onClose={onClose}>
    {loading && <p role="status">{copy('Loading…', '正在加载…')}</p>}
    {error && <div className="ow-skills-error" role="alert"><p>{error}</p><button type="button" disabled={saving || loading} onClick={() => setReload(value => value + 1)}>{copy('Reload and retry', '重新加载并重试')}</button></div>}
    {detail && <><p className="ow-skills-note">{copy('README falls back to the base language or default version. Package images and downloads use this exact version; unavailable resources are shown as text.', 'README 会回退到基础语言或默认版本。包内图片及下载使用当前固定版本；不可用的资源以文本展示。')}</p>
      <SkillReadme content={detail.readme} client={client.readSkillFile ? client as Pick<Transport, 'readSkillFile'> : undefined} id={detail.item.skillId} version={detail.item.packageVersion} copy={copy}/></>}
    {config && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="ow-skills-note">{copy('Configuration is stored on the Workspace host. Saved secrets are never displayed. Automatic use loads configuration as needed.', '配置保存在工作空间主机，已保存的密钥不会回显。自动使用时按需加载配置。')}</p>
      {!config.schema.environment.length && <p>{copy('This skill requires no configuration.', '此技能无需配置。')}</p>}
      {!!config.schema.environment.length && !config.packageVersion && <p role="alert">{copy('Workspace did not provide the installed package version. Reload settings or update the Workspace before saving.', '工作空间未返回已安装包版本，请重新加载设置或更新工作空间后保存。')}</p>}
      {config.schema.environment.map(field => {
        const text = skillFieldCopy(field, locale);
        const value = config.values.find(value => value.name === field.name);
        const edit = edits[field.name] ?? { mode: 'keep', value: '' };
        const editField = (next: SkillFieldEdit) => setEdits(previous => ({ ...previous, [field.name]: next }));
        const id = 'skill-field-' + field.name;
        return <fieldset key={field.name} disabled={saving} className="ow-skills-field"><legend>{text.label}{field.required ? ' *' : ''}</legend><small id={id + '-description'}>{text.description}</small><code>{field.name}</code>
          {field.secret ? <><p>{value?.configured ? copy('Secret is set', '密钥已设置') : copy('Secret is not set', '密钥未设置')}</p>
            <label>{copy('Secret action', '密钥操作')}<select value={edit.mode} onChange={event => editField({ mode: event.target.value as SkillFieldEdit['mode'], value: '' })}>
              <option value="keep">{copy('Keep saved value', '保留已保存的值')}</option><option value="replace">{copy('Replace', '替换')}</option><option value="clear">{copy('Clear', '清除')}</option></select></label>
            {edit.mode === 'replace' && <label htmlFor={id}>{copy('New secret', '新密钥')}<input id={id} type="password" autoComplete="new-password" value={edit.value} aria-describedby={id + '-description'} onChange={event => editField({ mode: 'replace', value: event.target.value })}/></label>}
          </> : <><label htmlFor={id}>{text.label}<input id={id} value={edit.mode === 'replace' ? edit.value : edit.mode === 'clear' ? '' : value?.value ?? field.default ?? ''} aria-describedby={id + '-description'} onChange={event => editField({ mode: 'replace', value: event.target.value })}/></label>
            <button type="button" onClick={() => editField({ mode: 'clear', value: '' })}>{copy('Clear saved value', '清除已保存的值')}</button>{field.default !== undefined && <small>{copy('Default', '默认值')}: {field.default}</small>}</>}
        </fieldset>;
      })}
      {!!missing.length && <p className="ow-skills-error" role="status">{copy('Required configuration missing', '缺少必填配置')}: {missing.join(', ')}</p>}
      {confirmClear && <div className="ow-skills-error"><p>{copy('Clear all saved configuration? Queued tasks that need it may be blocked.', '清除所有已保存配置？需要这些配置的排队任务可能会被阻塞。')}</p><button type="button" disabled={saving} onClick={() => { setConfirmClear(false); void save(true); }}>{copy('Confirm clear', '确认清除')}</button><button type="button" disabled={saving} onClick={() => setConfirmClear(false)}>{copy('Cancel', '取消')}</button></div>}
      <footer>{!!config.schema.environment.length && <button type="button" disabled={saving} onClick={() => setConfirmClear(true)}>{copy('Clear all configuration', '清除所有配置')}</button>}
        <button type="button" onClick={onClose}>{copy('Cancel', '取消')}</button>{!!config.schema.environment.length && <button type="submit" disabled={saving || !config.packageVersion || !Object.keys(skillConfigPatch(edits)).length}>{saving ? copy('Saving…', '正在保存…') : copy('Save', '保存')}</button>}</footer>
    </form>}
  </SkillDialog>;
}
