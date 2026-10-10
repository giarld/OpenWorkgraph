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
export interface SkillReference { skillId: string; source: 'openworkgraph' | 'codex'; name: string; start: number; end: number }
export interface SkillCandidate { skillId: string; source: 'openworkgraph' | 'codex'; name: string; description: string }
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
export interface FrozenSkill { skillId: string; source: 'openworkgraph' | 'codex'; name: string; description: string; path: string; packageVersion?: string; configRevision?: number; explicit: boolean; requiresConfiguration: boolean }
