import type { GraphScope } from '../../../packages/protocol/src/index';

export interface VisualizePagePermissions {
  network: boolean;
  downloads: boolean;
  clipboardRead: boolean;
  clipboardWrite: boolean;
  fullscreen: boolean;
  screenCapture: boolean;
  camera: boolean;
  microphone: boolean;
  geolocation: boolean;
  payment: boolean;
  usb: boolean;
  serial: boolean;
}
export type VisualizePagePermission = keyof VisualizePagePermissions;

export const DEFAULT_VISUALIZE_PAGE_PERMISSIONS: Readonly<VisualizePagePermissions> = Object.freeze({
  network: true, downloads: true, clipboardRead: true, clipboardWrite: true,
  fullscreen: true, screenCapture: true, camera: true, microphone: true, geolocation: true, payment: true, usb: true, serial: true,
});

const browserFeatures = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardRead: 'clipboard-read', clipboardWrite: 'clipboard-write',
  screenCapture: 'display-capture', fullscreen: 'fullscreen', payment: 'payment', usb: 'usb', serial: 'serial' } as const;

export function visualizeSandbox(value?: Partial<VisualizePagePermissions>): string {
  return 'allow-scripts' + (value?.downloads !== false ? ' allow-downloads' : '');
}
export function visualizeBrowserPermissions(value?: Partial<VisualizePagePermissions>): string {
  return Object.entries(browserFeatures).map(([key, feature]) => feature + (value?.[key as keyof typeof browserFeatures] === false ? " 'none'" : ' *')).join('; ');
}

export function normalizeVisualizePagePermissions(value: unknown): VisualizePagePermissions {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(DEFAULT_VISUALIZE_PAGE_PERMISSIONS).map(key => [key, record[key] !== false])) as unknown as VisualizePagePermissions;
}

export function visualizePermissionsKey(scope: GraphScope, nodeId: string, temporary: boolean): string {
  return 'openworkgraph:visualize-permissions:v1:' + JSON.stringify([temporary, scope.serviceId, scope.projectId, scope.graphId, nodeId]);
}

// Browser decisions belong to the viewer, never to author-controlled page packages.
const fallback = new Map<string, string>();
const changedEvent = 'openworkgraph:visualize-permissions-changed';
export function readVisualizePermissionsSnapshot(key: string): string {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return localStorage.getItem(key) ?? ''; }
  catch { return fallback.get(key) ?? ''; }
}
export function parseVisualizePermissionsSnapshot(snapshot: string): VisualizePagePermissions {
  try { return normalizeVisualizePagePermissions(JSON.parse(snapshot)); }
  catch { return { ...DEFAULT_VISUALIZE_PAGE_PERMISSIONS }; }
}
export function saveVisualizePermissions(key: string, value: VisualizePagePermissions): void {
  saveSnapshot(key, JSON.stringify(normalizeVisualizePagePermissions(value)));
}
function saveSnapshot(key: string, serialized: string): void {
  try { localStorage.setItem(key, serialized); fallback.delete(key); }
  catch { fallback.set(key, serialized); }
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: key }));
}

export function visualizePermissionUsageKey(permissionsKey: string): string { return permissionsKey + ':usage'; }
export function parseVisualizePermissionUsage(snapshot: string, pageRevision: number): VisualizePagePermission[] {
  try {
    const value = JSON.parse(snapshot);
    if (value?.pageRevision !== pageRevision || !Array.isArray(value.permissions)) return [];
    return (Object.keys(DEFAULT_VISUALIZE_PAGE_PERMISSIONS) as VisualizePagePermission[]).filter(key => value.permissions.includes(key));
  } catch { return []; }
}
/** Usage controls visibility only. It never grants or resets viewer permissions. */
export function noteVisualizePermissionUse(key: string, pageRevision: number, permission: VisualizePagePermission): void {
  if (!Number.isSafeInteger(pageRevision) || pageRevision < 1 || !Object.hasOwn(DEFAULT_VISUALIZE_PAGE_PERMISSIONS, permission)) return;
  const snapshot = readVisualizePermissionsSnapshot(key);
  try { if (JSON.parse(snapshot)?.pageRevision > pageRevision) return; } catch { /* First use. */ }
  const used = parseVisualizePermissionUsage(snapshot, pageRevision);
  if (used.includes(permission)) return;
  saveSnapshot(key, JSON.stringify({ pageRevision, permissions: [...used, permission] }));
}
export function subscribeVisualizePermissions(key: string, listener: () => void): () => void {
  const local = (event: Event) => { if ((event as CustomEvent).detail === key) listener(); };
  const remote = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return;
    try { if (event.storageArea !== localStorage) return; } catch { return; }
    fallback.delete(key); listener();
  };
  window.addEventListener(changedEvent, local);
  window.addEventListener('storage', remote);
  return () => { window.removeEventListener(changedEvent, local); window.removeEventListener('storage', remote); };
}
