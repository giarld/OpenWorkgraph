import type { SkillReference } from '../../../packages/protocol/src/skills';
import { legacySkillMentions } from '../../../packages/protocol/src/skills';
import { extractReferenceMention } from '../real/reference-mentions';
import { extractBuiltinFeatureMention } from '../real/builtin-feature-mentions';
import { extractProjectFileMarkdownLinks, validSkillReferences } from '../real/project-file-mentions';

export type PromptMentionToken = { start: number; end: number; raw: string; name: string; kind: string; path?: string; id?: string };
export function promptMentionTokens(value: string, skills: boolean, refs: readonly SkillReference[], skillNames: readonly string[]): PromptMentionToken[] {
  const result: PromptMentionToken[] = [];
  const pattern = /\[((?:\\.|[^\]])*)\]\((?:<((?:\\.|[^>\r\n])*)>|([^)\s]+))\)/g;
  for (const match of value.matchAll(pattern)) {
    const feature = extractBuiltinFeatureMention(match[0]);
    if (feature) result.push({ start: match.index!, end: match.index! + match[0].length, raw: match[0], ...feature });
    const reference = extractReferenceMention(match[0]);
    if (reference) result.push({ start: match.index!, end: match.index! + match[0].length, raw: match[0], ...reference });
    const item = extractProjectFileMarkdownLinks(match[0])[0];
    if (item) result.push({ start: match.index!, end: match.index! + match[0].length, raw: match[0], ...item, path: item.relativePath });
  }
  if (skills) for (const ref of validSkillReferences(value, refs)) {
    if (!result.some(token => ref.start < token.end && ref.end > token.start)) result.push({ start: ref.start, end: ref.end, raw: value.slice(ref.start, ref.end), name: ref.name, kind: 'skill' });
  }
  if (skills) for (const { name, start, end } of legacySkillMentions(value, skillNames)) {
    if ((start === 0 || /\s/.test(value[start - 1])) && (end === value.length || /[\s.,!?;，。！？；]/.test(value[end])) && !result.some(token => start < token.end && end > token.start)) result.push({ start, end, raw: value.slice(start, end), name, kind: 'skill' });
  }
  return result.sort((a, b) => a.start - b.start);
}
export function promptMentionIconPath(kind: string): string {
  return (kind === 'skill' || kind === 'builtin-feature') ? 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' : kind === 'directory' ? 'M3 7V5h6l2 2h10v13H3Z' : 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h6';
}
