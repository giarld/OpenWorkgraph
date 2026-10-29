import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROTOCOL_VERSION, type WorkspaceMaintenance } from '../../../packages/protocol/src/index';
import { ConnectionRegistry, type Connection } from '../adapter/connections';
import { useI18n } from '../i18n/I18nProvider';
import '../components/ConfirmationDialog.css';

// Status remains readable after restoration revokes the old browser sessions.
export function useWorkspaceMaintenance(registry: ConnectionRegistry, connections: Connection[]) {
  const addresses = JSON.stringify(connections.map(row => [row.serviceId, row.address]));
  const observed = useRef(new Set<string>());
  const [dismissed, setDismissed] = useState(new Set<string>());
  useEffect(() => {
    const controller = new AbortController();
    const stopPolls = registry.list().map(row => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      async function poll() {
        const attempt = new AbortController();
        const timeout = setTimeout(() => attempt.abort(), 5000);
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        try {
          const response = await registry.fetcher(row.address + '/v1/maintenance', { headers: { 'X-Workgraph-Protocol': PROTOCOL_VERSION, 'X-Workgraph-Service-Id': row.serviceId }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
          if (!response.ok) return;
          const state = await response.json() as WorkspaceMaintenance;
          if (!['idle', 'restoring', 'completed', 'failed'].includes(state.state) || typeof state.blocked !== 'boolean' || signal.aborted) return;
          if (state.blocked && state.operationId) observed.current.add(state.operationId);
          registry.setMaintenance(row.serviceId, state);
          if (state.state === 'completed' && state.operationId && observed.current.has(state.operationId) && registry.get(row.serviceId)?.status !== 'invalid') registry.invalidate(row.serviceId);
        } catch { /* Keep the last lock while the Workspace is unreachable. */ }
        finally {
          clearTimeout(timeout);
          if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 1000);
        }
      }
      void poll();
      return () => { clearTimeout(timer); };
    });
    return () => { controller.abort(); for (const stop of stopPolls) stop(); };
  }, [registry, addresses]);
  for (const row of connections) if (row.info.maintenance?.blocked && row.info.maintenance.operationId) observed.current.add(row.info.maintenance.operationId);
  const row = connections.find(row => {
    const state = row.info.maintenance;
    return state?.blocked || (state?.operationId && observed.current.has(state.operationId) && !dismissed.has(state.operationId));
  });
  return { maintenance: row?.info.maintenance, acknowledge: () => {
    const state = row?.info.maintenance;
    if (state?.blocked) return;
    if (state?.operationId) setDismissed(previous => new Set([...previous, state.operationId!]));
    // Clear cached graph/runtime state and require pairing with the restored workspace.
    window.location.reload();
  } };
}

export function WorkspaceMaintenanceDialog({ state, onAcknowledge }: { state: WorkspaceMaintenance; onAcknowledge(): void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return createPortal(<dialog ref={dialog} className="confirmation-dialog" aria-label={t('Workspace restoration')} onCancel={event => event.preventDefault()}>
    <h3>{t('Workspace restoration')}</h3>
    <p role="status">{state.state === 'restoring' ? t('Workspace restoration is in progress. All operations are temporarily blocked.') : state.state === 'completed' ? t('Backup restored. Refresh and pair with the Workspace again.') : state.blocked ? t('Restoration failed and the Workspace remains locked. Check Workspace logs and recover locally.') : t('Restoration failed. Previous data was retained. Check Workspace logs before trying again.')}</p>
    {!state.blocked && <div className="confirmation-dialog-actions"><button autoFocus type="button" onClick={onAcknowledge}>{t('Refresh Workspace')}</button></div>}
  </dialog>, document.body);
}
