import type { SkillConfiguration, SkillEnvironmentField } from '../../../packages/protocol/src/skills';
export type SkillFieldEdit = { mode: 'keep' | 'replace' | 'clear'; value: string };
export function skillFieldCopy(field: SkillEnvironmentField, locale: string): { label: string; description: string } {
  return field.translations?.[locale] ?? field.translations?.[locale.split('-')[0]!] ?? field;
}
/** Omitted values preserve secrets. null clears; empty strings remain strings. */
export function skillConfigPatch(edits: Record<string, SkillFieldEdit>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(edits).filter(([, edit]) => edit.mode !== 'keep').map(([name, edit]) => [name, edit.mode === 'clear' ? null : edit.value]));
}
export function missingSkillFields(config: SkillConfiguration, edits: Record<string, SkillFieldEdit>): string[] {
  return config.schema.environment.filter(field => {
    if (!field.required) return false;
    const edit = edits[field.name];
    if (edit?.mode === 'replace') return !edit.value.trim();
    if (edit?.mode === 'clear') return !field.default?.trim();
    const saved = config.values.find(value => value.name === field.name);
    return field.secret ? !saved?.configured : !(saved?.value ?? field.default)?.trim();
  }).map(field => field.name);
}
/** Package resources have no public endpoint yet; only absolute web links are navigable. */
export function skillReadmeWebUrl(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try { const url = new URL(value); return url.username || url.password ? undefined : url.href; }
  catch { return undefined; }
}
/** README lives at package root. Decode once and reject host paths or package traversal. */
export function skillReadmePackagePath(value: string | undefined): string | undefined {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('#')) return undefined;
  try {
    const path = decodeURIComponent(value.split(/[?#]/)[0]!).replace(/^\.\//, '');
    if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
    return path;
  } catch { return undefined; }
}
