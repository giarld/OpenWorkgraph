import type { VisualizeFeatureSelection } from './visualize.js';

/** Skill identities are portable; paths and configuration values never belong in graph packages. */
export const SKILL_NAME_PATTERN = '[A-Za-z0-9_.:-]+';
const skillName = new RegExp('^' + SKILL_NAME_PATTERN + '$');
export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && skillName.test(value);
}
/** Exact catalog names win, including names ending in dots. Otherwise trailing
 * dots are sentence punctuation; internal dots remain part of the name. */
export function legacySkillMentions(prompt: string, knownNames: readonly string[] = []): { name: string; start: number; end: number }[] {
  const known = new Set(knownNames);
  const result: { name: string; start: number; end: number }[] = [];
  for (const match of prompt.matchAll(new RegExp('(?:^|[^\\w$])\\$(' + SKILL_NAME_PATTERN + ')', 'g'))) {
    const raw = match[1]!;
    const base = raw.replace(/\.+$/, '');
    let name = raw;
    if (!known.has(raw)) {
      name = base || raw;
      for (let length = Math.min(raw.length - 1, 128); length > base.length; length--) {
        const candidate = raw.slice(0, length);
        if (known.has(candidate)) { name = candidate; break; }
      }
    }
    if (!isSkillName(name)) continue;
    const start = match.index! + match[0].lastIndexOf('$');
    result.push({ name, start, end: start + name.length + 1 });
  }
  return result;
}
export type SkillIdentity =
  | { source: 'openworkgraph'; skillId: string }
  | { source: 'codex'; skillId: string }
  | { source: 'agent'; backendId: string; skillId: string };
/** Read legacy provenance without rewriting frozen content or its digest. */
export function normalizeSkillIdentity(identity: SkillIdentity): SkillIdentity {
  return identity.source === 'codex'
    ? { source: 'agent', backendId: 'codex', skillId: identity.skillId }
    : identity.source === 'agent'
      ? { source: 'agent', backendId: identity.backendId, skillId: identity.skillId }
      : { source: 'openworkgraph', skillId: identity.skillId };
}
export function skillIdentityKey(identity: SkillIdentity): string {
  const normalized = normalizeSkillIdentity(identity);
  return JSON.stringify([normalized.source, normalized.source === 'agent' ? normalized.backendId : null, normalized.skillId]);
}
/** Display metadata is independent of portable/frozen identity. */
export function skillSourceLabel(identity: SkillIdentity & { backendName?: string }, backendNames: Readonly<Record<string, string>> = {}): string {
  if (identity.source === 'openworkgraph') return 'OpenWorkgraph';
  if (identity.source === 'codex') return 'Codex';
  const label = Object.hasOwn(backendNames, identity.backendId) ? backendNames[identity.backendId] : identity.backendName;
  return typeof label === 'string' && label.trim() ? label.trim() : identity.backendId;
}
/** Existing Codex wire keeps its portable behavior. A normalized alias is
 * legacy only when its opaque ID still contains the old absolute-path form. */
export function isLegacyCodexSkillIdentity(identity: SkillIdentity): boolean {
  if (identity.source === 'codex') return true;
  if (identity.source !== 'agent' || identity.backendId !== 'codex') return false;
  const id = identity.skillId.startsWith('codex:') ? identity.skillId.slice('codex:'.length) : identity.skillId;
  const backslash = String.fromCharCode(92);
  return id.startsWith('/') || id.startsWith(backslash + backslash) ||
    (/^[A-Za-z]:/.test(id) && (id[2] === '/' || id[2] === backslash));
}
/** Call only on portable copies. Preserve provenance; never rewrite a stored
 * node, frozen snapshot or digest input while reading/normalizing identities. */
export function portableSkillReference<T extends SkillIdentity & { name: string }>(reference: T): T {
  return isLegacyCodexSkillIdentity(reference) ? { ...reference, skillId: 'codex-unresolved:' + reference.name } : reference;
}
export function isSkillIdentity(value: unknown): value is SkillIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const id = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  if (!id(item.skillId, 4096)) return false;
  // Opaque skill IDs may contain slashes (including normalized historical IDs).
  // Registry membership is validated by the host, never inferred from a name.
  return item.source === 'agent' ? id(item.backendId, 128) && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(item.backendId as string)
    : ['openworkgraph', 'codex'].includes(String(item.source)) && item.backendId === undefined;
}
export type SkillReference = SkillIdentity & { name: string; start: number; end: number };
export type SkillCandidate = SkillIdentity & { name: string; description: string; backendName?: string };
/** Product functions are separate candidates, never installable skill identities. */
export interface BuiltinFeatureCandidate extends VisualizeFeatureSelection { name: string; description: string }
/** Keep legacy items unchanged; clients combine features with items for selection. */
export interface SkillCandidates { items: SkillCandidate[]; features?: BuiltinFeatureCandidate[] }
/** Both selections are frozen together, but only real skills resolve packages/configuration. */
export interface FrozenPromptSelection { skills: FrozenSkill[]; features: VisualizeFeatureSelection[] }
export interface SkillEnvironmentField { name: string; label: string; description: string; required: boolean; secret: boolean; default?: string; translations?: Record<string, { label: string; description: string }> }
export interface SkillConfigSchema { version: 1; environment: SkillEnvironmentField[] }
export interface SkillSource { id: string; repository: string; branch: string; directory: string }
export interface SkillCatalogItem { skillId: string; source: SkillSource; directory: string; name: string; description: string; installed: boolean; revision: number; packageVersion?: string; commitSha?: string; updateAvailable: boolean; configuration: 'none' | 'required' | 'ready'; error?: string }
export interface SkillCatalogQuery { offset?: number; limit?: number; installedOnly?: boolean; query?: string }
export interface SkillCatalog { items: SkillCatalogItem[]; stale: boolean; error?: string; total?: number; nextOffset?: number; installedSignature?: string }
export interface SkillDetail { item: SkillCatalogItem; readme: string; config: SkillConfigSchema }
export interface SkillConfigValue { name: string; configured: boolean; value?: string }
export interface SkillConfiguration { skillId: string; revision: number; schema: SkillConfigSchema; values: SkillConfigValue[]; packageVersion?: string }
export interface SkillConfigurationWrite { expectedRevision: number; values: Record<string, string | null>; expectedPackageVersion?: string }
/** Frozen public metadata. Credentials are resolved separately from protected revisions at launch. */
export type FrozenSkill = SkillIdentity & { name: string; description: string; path: string; packageVersion?: string; configRevision?: number; explicit: boolean; requiresConfiguration: boolean };
