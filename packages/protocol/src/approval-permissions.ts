/** Shared approval vocabulary for native adapters and public consumers.
 * Null means an unrequested known field. Unknown fields must never be dropped
 * to turn an unsupported request into an approvable subset. */
export interface ApprovalPermissions { network?: { enabled: boolean }; fileSystem?: { read?: string[]; write?: string[] } }
export const APPROVAL_MAX_PATHS = 100;
export const APPROVAL_MAX_PATH_LENGTH = 4096;
export function validApprovalPaths(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= APPROVAL_MAX_PATHS
    && value.every(path => typeof path === 'string' && !!path.trim() && path.length <= APPROVAL_MAX_PATH_LENGTH);
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function normalizeApprovalPermissions(value: unknown): ApprovalPermissions | null {
  if (!record(value) || Object.keys(value).some(key => !['network', 'fileSystem'].includes(key))) return null;
  const result: ApprovalPermissions = {};
  let requested = false;
  if (value.network != null) {
    const network = value.network;
    if (!record(network) || Object.keys(network).some(key => key !== 'enabled') || !('enabled' in network) || (network.enabled !== null && typeof network.enabled !== 'boolean')) return null;
    if (typeof network.enabled === 'boolean') { result.network = { enabled: network.enabled }; requested ||= network.enabled; }
  }
  if (value.fileSystem != null) {
    const files = value.fileSystem;
    if (!record(files) || Object.keys(files).some(key => !['read', 'write'].includes(key))) return null;
    const normalized: NonNullable<ApprovalPermissions['fileSystem']> = {};
    for (const key of ['read', 'write'] as const) {
      if (!Object.hasOwn(files, key) || files[key] === null) continue;
      const paths = files[key];
      if (!validApprovalPaths(paths, true)) return null;
      normalized[key] = [...paths];
      requested ||= paths.length > 0;
    }
    if (Object.keys(normalized).length) result.fileSystem = normalized;
  }
  return requested && JSON.stringify(result).length <= 32000 ? result : null;
}
