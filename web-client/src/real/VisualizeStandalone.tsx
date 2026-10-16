import { useEffect, useRef, useState } from 'react';
import { PanelsTopLeft } from 'lucide-react';
import type { GraphScope, GraphSnapshot, Json, Project } from '../../../packages/protocol/src/index';
import { ConnectionRegistry } from '../adapter/connections';
import { Transport } from '../adapter/transport';
import { EventSubscription } from '../adapter/events';
import { useI18n } from '../i18n/I18nProvider';
import { graphPath, messageOf, type Request } from './contracts';
import { TemporaryCanvasStore } from './temporary-store';
import { VisualizeNode, VisualizeSessions } from './VisualizeNode';
import { VisualizeNodePreview } from './VisualizeNodePreview';
import { createAuthoritativeLoader } from './authoritative-loader';
import { createBatchedRefresh, GRAPH_REFRESH_BATCH_MS } from './batched-refresh';

function standaloneSelection(): { scope: GraphScope; nodeId: string; temporary: boolean; theme: 'light' | 'dark' } | undefined {
  const query = new URLSearchParams(location.search);
  const fields = ['serviceId', 'projectId', 'graphId', 'nodeId'] as const;
  if (fields.some(field => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(query.get(field) ?? ''))) return;
  return { scope: { serviceId: query.get('serviceId')!, projectId: query.get('projectId')!, graphId: query.get('graphId')! }, nodeId: query.get('nodeId')!, temporary: query.get('temporary') === 'true', theme: query.get('theme') === 'light' ? 'light' : 'dark' };
}
function object(value: Json | undefined): Record<string, Json> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

/** An independent host with its own authenticated connection or IndexedDB session. */
export function VisualizeStandalone() {
  const { t, locale } = useI18n();
  const [selection] = useState(standaloneSelection);
  const [owner, setOwner] = useState<VisualizeSessions>();
  const [graph, setGraph] = useState<GraphSnapshot>();
  const [online, setOnline] = useState(false);
  const [projectActive, setProjectActive] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const refresh = useRef<() => Promise<unknown>>(async () => undefined);
  useEffect(() => {
    if (selection) document.documentElement.dataset.theme = selection.theme;
  }, [selection]);
  useEffect(() => {
    if (!selection) return;
    let active = true;
    const { scope, temporary } = selection;
    const registry = temporary ? undefined : new ConnectionRegistry();
    let sessions: VisualizeSessions | undefined, stream: EventSubscription | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let graphRefresh: ReturnType<typeof createBatchedRefresh> | undefined;
    setOwner(undefined); setGraph(undefined); setOnline(false); setError('');
    const fail = (reason: unknown) => { if (active) setError(messageOf(reason)); };
    const start = async () => {
      let request: Request, transport: Transport | undefined;
      if (temporary) {
        const store = new TemporaryCanvasStore();
        request = store.request.bind(store);
      } else {
        await registry!.restore([scope.serviceId]);
        if (!active) return;
        if (registry!.get(scope.serviceId)?.status !== 'paired') throw Error(t('Pair with the Workspace or restore its session'));
        transport = new Transport(registry!, scope.serviceId);
        request = transport.request.bind(transport);
      }
      const readAuthority = createAuthoritativeLoader(async () => {
        const cursor = transport ? (await request<{ cursor: string }>('/v1/events/cursor')).cursor : '';
        const [snapshot, projects, runs] = await Promise.all([
          request<GraphSnapshot>(graphPath(scope.projectId, scope.graphId)),
          transport ? request<Project[]>('/v1/projects/all') : Promise.resolve(undefined),
          transport ? request<import('../../../packages/protocol/src/index').Run[]>(graphPath(scope.projectId, scope.graphId) + '/runs') : Promise.resolve([]),
        ]);
        return {cursor,snapshot,projects,runs};
      }, ({snapshot,projects,runs}) => {
          sessions?.signals.observe(snapshot, runs);
          sessions?.retain(snapshot.nodes.filter(node => node.type === 'visualize').map(node => node.id));
          setGraph(snapshot); setError('');
          setProjectActive(!projects || projects.some(project => project.projectId === scope.projectId && project.state === 'active' && project.availability === 'available'));
      }, () => { if (!active) throw Error('Page session ended'); });
      const load = async () => (await readAuthority()).cursor;
      refresh.current = load;
      graphRefresh = createBatchedRefresh(load, reason => { fail(reason); stream?.reconnect(); }, GRAPH_REFRESH_BATCH_MS);
      sessions = new VisualizeSessions(request, scope);
      const cursor = await load();
      if (!active) return;
      setOwner(sessions);
      if (transport) {
        stream = new EventSubscription(transport, scope.serviceId, {
          onEvent: async event => {
            if (event.projectId !== scope.projectId || event.type.startsWith('canvas_resource.')) return;
            sessions?.signals.observeEvent(event);
            if (event.type === 'graph.changed') graphRefresh?.schedule();
            else void load().catch(reason => { fail(reason); stream?.reconnect(); });
          },
          reloadSnapshot: load,
          onError: fail,
          onStatus: status => { if (active) setOnline(status === 'connected'); },
        }, { cursor });
        stream.start();
      } else {
        setOnline(true);
        // IndexedDB has no service events; refresh metadata without accepting inputs.
        timer = setInterval(() => { if (document.visibilityState === 'visible') void load().catch(fail); }, 3000);
      }
    };
    void start().catch(fail);
    const focus = () => { void refresh.current().catch(fail); };
    window.addEventListener('focus', focus);
    return () => { active = false; clearInterval(timer); graphRefresh?.dispose(); stream?.stop(); sessions?.dispose(); registry?.dispose(); refresh.current = async () => undefined; window.removeEventListener('focus', focus); };
  }, [selection, retry, t]);
  const node = graph?.nodes.find(item => item.id === selection?.nodeId && item.type === 'visualize');
  const content = object(node?.content);
  const title = typeof content.title === 'string' && content.title ? content.title : t('Interactive page');
  useEffect(() => { document.title = title + ' · ' + t('OpenWorkgraph'); }, [title, t]);
  return <main className="ow-visualize-standalone">
    <header><PanelsTopLeft size={18} aria-hidden="true"/><h1>{title}</h1></header>
    {!selection || (graph && !node) ? <p role="alert">{t('The visualization node is unavailable.')}</p> : <>
      {error && <div role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></div>}
      {owner && graph && node ? <VisualizeNodePreview owner={owner} nodeId={node.id} contentVersion={node.contentVersion}>
        <VisualizeNode owner={owner} nodeId={node.id} pageRevision={Number(object(content.page).revision ?? 0)} theme={selection.theme} locale={locale} online={online} readOnly={!projectActive || graph.archived || graph.trashed || node.readOnly} temporary={selection.temporary} expanded standalone onChanged={() => refresh.current().then(() => undefined).catch(reason => setError(messageOf(reason)))} onError={reason => setError(messageOf(reason))} onOpenPrompt={() => setError(t('Generate an interactive page before downloading it.'))}/>
      </VisualizeNodePreview> : !error && <p role="status">{t('Loading interactive page…')}</p>}
    </>}
  </main>;
}
