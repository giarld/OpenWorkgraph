import { useSyncExternalStore, type ComponentType } from 'react';
import type { Node } from './contracts';
import { useI18n } from '../i18n/I18nProvider';
import { translate } from '../i18n/translate';

export interface TrustedNodeViewProps { node: Node; readonly: boolean }
export interface TrustedNodeViewRegistration {
  type: string;
  schemaVersion: number;
  Component: ComponentType<TrustedNodeViewProps>;
}

// This is an application-code registration API, not a plugin loader or sandbox.
// Graph JSON supplies lookup keys only. There is no URL, source string, eval,
// dynamic import or lazy-loader path here; callers must trust registered code.
const registry = new Map<string, Map<number, TrustedNodeViewRegistration[]>>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribeTrustedNodeViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable primitive snapshots for useSyncExternalStore. */
export function getTrustedNodeViewsVersion(): number { return version; }

function changed(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

function isLocalComponent(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'function') return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const component = value as { $$typeof?: unknown; type?: unknown; render?: unknown };
  // Support locally constructed memo/forwardRef components, but not React.lazy
  // loaders. JSON cannot encode either functions or these symbol identities.
  return (component.$$typeof === Symbol.for('react.memo') && isLocalComponent(component.type, seen)) ||
    (component.$$typeof === Symbol.for('react.forward_ref') && typeof component.render === 'function');
}

/** The newest exact-match registration wins. Cleanup removes only its own
 * layer, even when registrations are unmounted out of order. */
export function registerTrustedNodeView(definition: TrustedNodeViewRegistration): () => void {
  if (!definition || typeof definition.type !== 'string' || !definition.type.trim()) throw new Error(translate('Node type cannot be empty.'));
  if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 1) throw new Error(translate('schemaVersion must be a positive integer.'));
  if (!isLocalComponent(definition.Component)) throw new Error(translate('Only trusted local React components can be registered. JSON, URLs, and code strings are not allowed.'));
  const registered = Object.freeze({ ...definition });
  let schemas = registry.get(registered.type);
  if (!schemas) { schemas = new Map(); registry.set(registered.type, schemas); }
  const layers = schemas.get(registered.schemaVersion) ?? [];
  layers.push(registered);
  schemas.set(registered.schemaVersion, layers);
  changed();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    layers.splice(layers.indexOf(registered), 1);
    if (!layers.length) schemas.delete(registered.schemaVersion);
    if (!schemas.size) registry.delete(registered.type);
    changed();
  };
}

/** No fallback to older/newer schemas and no implicit data migration. */
export function getTrustedNodeView(type: string, schemaVersion: number): ComponentType<TrustedNodeViewProps> | undefined {
  return registry.get(type)?.get(schemaVersion)?.at(-1)?.Component;
}

export function RealPluginView({ node, readonly }: TrustedNodeViewProps) {
  const {t} = useI18n();
  useSyncExternalStore(subscribeTrustedNodeViews, getTrustedNodeViewsVersion, getTrustedNodeViewsVersion);
  const Component = getTrustedNodeView(node.type, node.schemaVersion);
  if (Component) return <Component key={JSON.stringify([node.id, node.type, node.schemaVersion])} node={node} readonly={readonly || node.readOnly} />;
  return <section aria-label={t('Missing node view')}>
    <p role="status">{t('Missing node view: {type} (schema {schemaVersion}). The original JSON was preserved; no plugin was executed and no data was migrated.', {type:node.type,schemaVersion:node.schemaVersion})}</p>
    <details><summary>{t('View raw node JSON')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(node, null, 2)}</pre></details>
  </section>;
}
