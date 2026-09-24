import type { Connection } from '../adapter/connections';
import { runtimeNeedsUpgrade } from '../domain/runtime-version';
import { executionUnavailableReason } from './execution-availability';
import { translate as t } from '../i18n/translate';
import '../i18n/catalogs/app';

export function runtimeStatus(connection: Connection | undefined, eventStatus: 'starting' | 'connected' | 'offline' | undefined, error: string | undefined, clientVersion: string) {
  let state: 'normal' | 'disconnected' | 'error' | 'upgrade' = 'disconnected';
  let reason = t('No Runtime connected');
  if (connection) {
    if (connection.status === 'invalid') {
      state = 'error';
      reason = t('Session expired. Pair again.');
    } else if (connection.status === 'offline' || eventStatus === 'offline') {
      reason = t('Runtime disconnected');
    } else if (error) {
      state = 'error';
      reason = t('Runtime cannot work normally');
    } else if (eventStatus !== 'connected') {
      reason = t('Runtime connecting or synchronizing');
    } else if (connection.info.capabilities.execution?.status !== 'available') {
      state = 'error';
      reason = executionUnavailableReason(true, false, connection.info.capabilities.execution)!;
    } else {
      state = 'normal';
      reason = t('Runtime working normally');
    }
  }
  const upgrade = connection && runtimeNeedsUpgrade(connection.info.version, clientVersion)
    ? t('Upgrade Runtime v{runtimeVersion} to v{clientVersion}', { runtimeVersion: connection.info.version, clientVersion })
    : undefined;
  if (state === 'normal' && upgrade) {
    state = 'upgrade';
    reason = t('Runtime upgrade required');
  }
  const name = connection?.runtimeName || connection?.address || t('No Runtime connected');
  const details = [name, reason, error, connection?.runtimeName ? connection.address : undefined,
    connection ? t('Runtime version: v{version}', { version: connection.info.version }) : undefined, upgrade]
    .filter(Boolean).join('\n');
  return { state, name, details };
}
