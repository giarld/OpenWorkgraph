import { ServiceError } from './errors.js';

const fields: Record<string, string> = {
  acceptedTasksUnaffected: 'Accepted tasks unaffected', activeRuns: 'Active runs', available: 'Available', backupId: 'Backup ID', browserName: 'Client name', bytes: 'Size', capacity: 'Capacity', code: 'Pairing code', createdAt: 'Created at', current: 'Current session', currentVersion: 'Current version', endpoints: 'Runtime endpoints', event: 'Event', expiresAt: 'Expires at', fingerprint: 'Public key fingerprint SHA-256', id: 'ID', instanceId: 'Instance ID', integrity: 'Integrity', invalidatesAllSessions: 'Invalidates all sessions', lastUsedAt: 'Last used at', latestVersion: 'Latest version', listenHost: 'Listen address', localEndpoint: 'Local endpoint', location: 'Storage location', mode: 'Mode', occupied: 'Occupied', origin: 'Web origin', output: 'Output file', packageName: 'Package', pairedAt: 'Paired at', pairingCommand: 'Pairing command', pausesQueuedRuns: 'Pauses queued runs', pluginId: 'Plugin ID', registered: 'Registered', requiresMaintenance: 'Requires maintenance', restarted: 'Runtime restarted', restored: 'Restored', revoked: 'Revoked session', schemaVersion: 'Schema version', serviceId: 'Runtime ID', sha256: 'SHA-256', state: 'State', time: 'Time', typeId: 'Type ID', updateAvailable: 'Update available', updated: 'Package updated', version: 'Version',
};
const titles: Record<string, string> = {
  'backup create': 'Backup created', 'backup download': 'Backup downloaded', 'backup list': 'Backups', capacity: 'Runtime capacity', logs: 'Runtime logs', 'plugin register': 'Plugin registered', restart: 'Runtime restarted', 'restore apply': 'Backup restored', 'restore preview': 'Restore preview', 'revoke-session': 'Session revoked', sessions: 'Client sessions', start: 'Runtime started', status: 'Runtime status', stop: 'Runtime stopping', update: 'Runtime update',
};
const states: Record<string, string> = { active: 'Active', creating: 'Creating', draining: 'Draining', expired: 'Expired', failed: 'Failed', interrupting: 'Interrupting', ready: 'Ready', running: 'Running' };
const events: Record<string, string> = { backup_failed: 'Backup failed', backup_ready: 'Backup ready', draining: 'Draining started', interrupting: 'Interrupting', restored: 'Restored', shutdown_failed: 'Shutdown failed', started: 'Started', startup_failed: 'Startup failed', stopped: 'Stopped' };
const values: Record<string, string> = { pairing: 'Waiting for client pairing', verified: 'Verified' };
const translatedErrors = new Map<string, string>([
  ['Unknown command; use --help', 'Unknown command. Use --help to see available commands.'],
  ['Port must be an integer from 0 to 65535', 'Port must be an integer from 0 to 65535.'],
  ['Unexpected arguments', 'Unexpected arguments. Use --help for command syntax.'],
  ['Service not running or management unavailable', 'The service is not running or local management is unavailable.'],
  ['Startup acknowledgment timed out; inspect status before retrying', 'Startup confirmation timed out. Run status before retrying.'],
  ['Service is still draining; interactions/cancel remain available', 'The service is still draining; interactions and cancellation remain available.'],
]);
const fallbackErrors: Record<string, string> = {
  INVALID_REQUEST: 'The command request is invalid.',
  ORIGIN_DENIED: 'The client origin is not allowed.',
  PAIRING_CODE_EXPIRED: 'The pairing code has expired. Generate a new code in the browser.',
  PAIRING_CODE_INVALID: 'The pairing code is invalid. Generate a new code in the browser.',
  PAIRING_CODE_USED: 'The pairing code has already been used. Generate a new code in the browser.',
  SERVICE_MISMATCH: 'The client code belongs to a different runtime.',
  SERVICE_NOT_RUNNING: 'The runtime is not running or local management is unavailable.',
};

function displayWidth(value: string): number { return [...value].reduce((width, char) => width + (/[^\x00-\xff]/.test(char) ? 2 : 1), 0); }
function padLabel(value: string, width: number): string { return value + ' '.repeat(Math.max(0, width - displayWidth(value))); }
function formatDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('en-US', { hour12: false });
}
function formatBytes(value: number): string {
  if (value < 1024) return value + ' B';
  const units = ['KB', 'MB', 'GB', 'TB']; let size = value / 1024; let unit = units[0]!;
  for (let index = 1; index < units.length && size >= 1024; index++) { size /= 1024; unit = units[index]!; }
  return size.toFixed(size >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, '') + ' ' + unit;
}
function scalar(key: string, value: unknown): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return key === 'bytes' ? formatBytes(value) : String(value);
  if (typeof value === 'string') {
    if (key === 'state' && states[value]) return states[value];
    if (key === 'event' && events[value]) return events[value];
    if (key.endsWith('At') || key === 'time') return formatDate(value);
    return values[value] || value || '—';
  }
  return String(value);
}
function recordLines(value: Record<string, unknown>, indent = '  '): string[] {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  const scalarEntries = entries.filter(([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
  const labelWidth = Math.max(0, ...scalarEntries.map(([key]) => displayWidth(fields[key] ?? key)));
  const lines = scalarEntries.map(([key, item]) => indent + padLabel(fields[key] ?? key, labelWidth) + '  ' + scalar(key, item));
  for (const [key, item] of entries) {
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) continue;
    const label = fields[key] ?? key;
    if (Array.isArray(item)) {
      if (item.every(entry => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))) lines.push(indent + label + '  ' + (item.length ? item.map(entry => scalar(key, entry)).join(', ') : '—'));
      else { lines.push(indent + label); lines.push(...listLines(item, indent + '  ')); }
    } else if (typeof item === 'object') { lines.push(indent + label); lines.push(...recordLines(item as Record<string, unknown>, indent + '  ')); }
  }
  return lines;
}
function listLines(items: unknown[], indent = '  '): string[] {
  if (items.length === 0) return [indent + 'No records.'];
  const lines: string[] = [];
  items.forEach((item, index) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) { lines.push(indent + (index + 1) + '.'); lines.push(...recordLines(item as Record<string, unknown>, indent + '   ')); }
    else lines.push(indent + (index + 1) + '. ' + scalar('', item));
    if (index < items.length - 1) lines.push('');
  });
  return lines;
}
export function formatHumanOutput(command: string, value: unknown): string {
  const title = titles[command] ?? 'Command result';
  const lines = Array.isArray(value) ? listLines(value) : value && typeof value === 'object' ? recordLines(value as Record<string, unknown>) : ['  ' + scalar('', value)];
  return ['', title, '', ...lines, ''].join('\n');
}
export function printOutput(command: string, value: unknown, outputJson = false): void { console.log(outputJson ? JSON.stringify(value) : formatHumanOutput(command, value)); }
export function formatPairingResult(value: unknown, outputJson = false): string {
  if (outputJson) return JSON.stringify(value);
  const result = value as { code?: string; origin: string; expiresAt: string; serviceId: string; endpoints?: string[] };
  if (result.code) return ['', 'Legacy client authorization completed', '', '  One-time pairing code  ' + result.code, '', '  Valid for              5 minutes, one use only', '  Expires at             ' + formatDate(result.expiresAt), '  Web origin             ' + result.origin, '  Runtime ID             ' + result.serviceId, ...(result.endpoints?.length ? ['  Runtime endpoints      ' + result.endpoints.join(', ')] : []), '', 'Return to the original browser page and enter the pairing code above.', ''].join('\n');
  return ['', 'Client pairing approved', '', '  Web origin             ' + result.origin, '  Runtime ID             ' + result.serviceId, '  Request expires at     ' + formatDate(result.expiresAt), ...(result.endpoints?.length ? ['  Runtime endpoints      ' + result.endpoints.join(', ')] : []), '', 'The browser will detect approval and connect automatically. Keep the pairing page open.', ''].join('\n');
}
export function formatCliError(error: unknown, outputJson = false): string {
  const code = error instanceof ServiceError ? error.code : 'STARTUP_FAILED';
  const raw = error instanceof Error ? error.message : 'Command failed.';
  const source = raw.startsWith('Background startup refused: ') ? raw.slice('Background startup refused: '.length) : raw;
  const message = translatedErrors.get(source) ?? (/\p{Script=Han}/u.test(source) ? fallbackErrors[code] ?? 'The command failed. See the error code for details.' : source);
  if (outputJson) return JSON.stringify({ code, message });
  const width = Math.max(displayWidth('Code'), displayWidth('Reason'));
  return ['', 'Command failed', '', '  ' + padLabel('Code', width) + '  ' + code, '  ' + padLabel('Reason', width) + '  ' + message, ''].join('\n');
}
