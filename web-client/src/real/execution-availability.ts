import type { Capability } from '../../../packages/protocol/src/index';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
import { displayTerminology } from '../i18n/display-terminology';

/** Connection and model discovery do not imply that a runtime accepts Runs. */
export function executionUnavailableReason(online: boolean, temporary: boolean, capability?: Capability): string | undefined {
  if (!online) return translate("The Workspace is disconnected or synchronizing. Connect it and try again.");
  if (temporary) return translate("The connected Workspace does not support running temporary Work Graphs yet.");
  if (capability?.status === 'available') return undefined;
  if (capability?.reason.includes('ISOLATION_UNVERIFIED')) return translate("The Workspace is connected, but execution is disabled because file isolation verification failed. An available model list does not mean tasks can be executed.");
  if (capability?.reason.includes('explicitly disabled')) return translate("The Workspace is connected, but execution is disabled by its configuration.");
  const unknown = capability?.status === 'unknown';
  if (capability?.reason) return unknown
    ? translate('The Workspace is connected, but execution capability has not been confirmed: {reason}', { reason: displayTerminology(capability.reason) })
    : translate('The Workspace is connected, but execution capability is unavailable: {reason}', { reason: displayTerminology(capability.reason) });
  return unknown
    ? translate('The Workspace is connected, but execution capability has not been confirmed.')
    : translate('The Workspace is connected, but execution capability is unavailable.');
}
