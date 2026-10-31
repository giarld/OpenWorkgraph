import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import sdkSource from 'virtual:visualize-sdk';
import { bindVisualizeIframe } from '../../../packages/protocol/src/visualize-browser-host';
import { validateVisualizeBridgeRequest, validateVisualizeBridgeResponse } from '../../../packages/protocol/src/visualize-bridge';
import { validateVisualizeAssetPackageBytes, readVisualizeAssetPage, VISUALIZE_LIBRARY_MAX_JSON_BYTES } from '../../../packages/protocol/src/visualize-library';
import type { BundleResource, VisualizeBridgeRequest, VisualizeBridgeResponse, VisualizeHostContext } from '../../../packages/protocol/src/index';
import { randomId } from '../adapter/random';
import { useI18n } from '../i18n/I18nProvider';
import { translate } from '../i18n/translate';
import type { LibraryAsset, ResourceRequest } from './ResourcesPanel';
import { bindVisualizeAssetTransport, visualizeAssetMedia, visualizeBinaryResource, type VisualizeBinaryAsset } from './visualize-assets';
import { prepareVisualizeHtmlDocument, VISUALIZE_HTML_PERMISSIONS, VISUALIZE_HTML_SANDBOX, type VisualizeStaticResource } from './visualize-html';

/** The preview owns no graph, transport or write capability. All writes fail locally. */
export function createVisualizePreviewBridge(identity: { sessionId: string; nodeId: string }, context: VisualizeHostContext) {
  let closed = false;
  return { close() { closed = true; }, async dispatch(value: VisualizeBridgeRequest): Promise<VisualizeBridgeResponse> {
    const request = validateVisualizeBridgeRequest(value);
    const base = { channel: request.channel, version: request.version, sessionId: request.sessionId, nodeId: request.nodeId, requestId: request.requestId, type: 'response' as const, method: request.method };
    if (closed || request.sessionId !== identity.sessionId || request.nodeId !== identity.nodeId) return validateVisualizeBridgeResponse({ ...base, ok: false, error: { code: 'SESSION_EXPIRED', message: translate('Preview session expired.'), retryable: false } });
    if (request.method === 'initialize') return validateVisualizeBridgeResponse({ ...base, ok: true, result: { ...structuredClone(context), capabilities: { readOnly: true, online: true, canCreateSuccessors: false, canExportAssets: false } } });
    if (request.method === 'readInputs' && !request.params.refresh) return validateVisualizeBridgeResponse({ ...base, ok: true, result: { inputs: structuredClone(context.inputs), inputsChanged: false } });
    return validateVisualizeBridgeResponse({ ...base, ok: false, error: { code: 'READ_ONLY', message: translate('Add this content to a Work Graph to interact fully.'), retryable: false } });
  } };
}
const decode = (resource: BundleResource) => Uint8Array.from(atob(resource.base64), character => character.charCodeAt(0));

export function VisualizeAssetPreview({ request, path, asset, onClose, onError }: { request: ResourceRequest; path: string; asset: LibraryAsset; onClose(): void; onError(error: unknown): void }) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const backdrop = useRef<HTMLDivElement>(null), dialog = useRef<HTMLElement>(null), iframe = useRef<HTMLIFrameElement>(null);
  const previousFocus = useRef(document.activeElement);
  const latest = useRef({ onClose, onError }); latest.current = { onClose, onError };
  const binding = useRef<ReturnType<typeof bindVisualizeIframe> | undefined>(undefined);
  const prepared = useRef<{ identity: { sessionId: string; nodeId: string }; bridge: ReturnType<typeof createVisualizePreviewBridge> } | undefined>(undefined);
  const [html, setHtml] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const priorInert = new Map<HTMLElement, boolean>();
    const isolate = () => { for (const child of document.body.children) {
      if (!(child instanceof HTMLElement) || child === backdrop.current) continue;
      if (!priorInert.has(child)) priorInert.set(child, child.inert); child.inert = true;
    } };
    isolate(); const observer = new MutationObserver(isolate); observer.observe(document.body, { childList: true });
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { observer.disconnect(); for (const [element, inert] of priorInert) element.inert = inert; const previous = previousFocus.current; if (previous instanceof HTMLElement && previous.isConnected) {
      const target = previous.closest('.ow-assets-card')?.querySelector<HTMLElement>('.ow-assets-thumbnail') ?? previous;
      target?.focus({ preventScroll: true });
    } };
  }, []);
  useEffect(() => {
    let active = true, unbindAssets: (() => void) | undefined;
    setHtml(''); setError('');
    const load = async () => {
      const blob = await request<Blob>(path + '/content', undefined, 'BLOB');
      if (!active) return;
      if (blob.size > VISUALIZE_LIBRARY_MAX_JSON_BYTES) throw new Error(t('Interactive content exceeds the preview size limit.'));
      const pkg = await validateVisualizeAssetPackageBytes(await blob.text());
      if (!active) return;
      const content = pkg.node.content;
      const page = readVisualizeAssetPage(pkg);
      const identity = { sessionId: randomId(), nodeId: randomId() };
      const tokens: Record<string, string> = {}, style = getComputedStyle(document.documentElement);
      for (const name of ['canvas', 'panel', 'fill', 'text', 'muted', 'stroke', 'active', 'link', 'danger']) { const value = style.getPropertyValue('--' + name).trim(); if (value) tokens[name] = value; }
      const theme = { mode: document.documentElement.dataset.theme === 'dark' || style.colorScheme === 'dark' ? 'dark' as const : 'light' as const, tokens };
      const context: VisualizeHostContext = { pageRevision: content.page!.revision, form: content.form!, state: content.state!, inputs: { version: 1, digest: '0'.repeat(64), inputs: [] }, inputsChanged: false,
        revisions: { pageRevision: content.page!.revision, formVersion: content.form!.version, stateVersion: content.state!.version, inputVersion: 1, executionRevision: 0, layoutRevision: 0 }, theme, locale, viewport: { width: Math.max(1, dialog.current?.clientWidth || pkg.node.width), height: Math.max(1, pkg.node.height) }, capabilities: { readOnly: true, online: true, canCreateSuccessors: false, canExportAssets: false } };
      // Send every supported fixed resource, including refs present only in schema,
      // initial/current form or state. Never resolve source graph/project identities.
      const resources: VisualizeStaticResource[] = [], binaries: VisualizeBinaryAsset[] = [];
      for (const resource of pkg.resources) {
        const media = visualizeAssetMedia(resource.mime);
        const fixed = visualizeBinaryResource({ format: 'openworkgraph.asset-reference', version: 1, kind: 'resource', resourceId: resource.resourceId, resourceVersion: resource.version }, media);
        resources.push(fixed); binaries.push({ key: 'visualize-resource:' + encodeURIComponent(resource.resourceId) + '@' + resource.version, media, mime: resource.mime, bytes: decode(resource).buffer as ArrayBuffer });
      }
      const documentHtml = await prepareVisualizeHtmlDocument({ page, ...identity, hostOrigin: location.origin, sdkSource, resources, theme, locale, expanded: true });
      if (!active) return;
      prepared.current = { identity, bridge: createVisualizePreviewBridge(identity, context) };
      unbindAssets = bindVisualizeAssetTransport(window, () => iframe.current, identity, binaries);
      setHtml(documentHtml);
    };
    void load().catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : String(reason)); latest.current.onError(reason); } });
    return () => { active = false; unbindAssets?.(); binding.current?.dispose(); binding.current = undefined; prepared.current?.bridge.close(); prepared.current = undefined; };
  }, [request, path, retry, locale, t]);
  return createPortal(<div ref={backdrop} className="ow-asset-preview-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="ow-asset-preview-dialog ow-visualize-asset-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') { const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),iframe')).filter(control => control.checkVisibility()); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <header><div><small>{t('Asset preview · v{version}', { version: asset.current.version })} · VISUALIZE</small><h2 id={titleId}>{asset.current.presentation?.title || asset.name}</h2></div><button type="button" aria-label={t('Close preview')} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
    <p className="ow-visualize-preview-notice">{t('Read-only preview. Add to a Work Graph to interact fully.')}{asset.current.presentation?.usesCdn && <span>{t('This content requires network dependencies.')}</span>}</p>
    {error ? <div role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></div> : !html ? <p role="status">{t('Loading interactive content…')}</p> : <iframe ref={iframe} title={t('View interactive content: {name}', { name: asset.current.presentation?.title || asset.name })} sandbox={VISUALIZE_HTML_SANDBOX} allow={VISUALIZE_HTML_PERMISSIONS} referrerPolicy="no-referrer" srcDoc={html} onLoad={() => { const current = prepared.current; if (!current || !iframe.current || binding.current) return; binding.current = bindVisualizeIframe({ window, iframe: iframe.current, ...current.identity, dispatch: current.bridge.dispatch, onDismiss: () => latest.current.onClose() }); }} />}
    {html && <footer><button onClick={() => setRetry(value => value + 1)}>{t('Reload preview')}</button></footer>}
  </section></div>, document.body);
}
