import { isSkillName, isSkillIdentity, type SkillReference } from './skills.js';
import { VISUALIZE_FEATURE_ID, type VisualizeFeatureSelection } from './visualize.js';

export interface PromptEdit { start: number; end: number; text: string }

export function validSkillReferences(value: string, input: unknown): SkillReference[] {
  if (!Array.isArray(input)) return [];
  const result: SkillReference[] = [];
  for (const ref of input) {
    if (!ref || typeof ref !== "object" || Object.keys(ref).some(key => !["skillId", "source", "backendId", "name", "start", "end"].includes(key)) ||
      typeof ref.skillId !== "string" || !ref.skillId.trim() || ref.skillId.length > 4096 || /[\x00-\x1f]/.test(ref.skillId) ||
      !isSkillIdentity({ ...ref }) || !isSkillName(ref.name) ||
      !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end > value.length ||
      value.slice(ref.start, ref.end) !== "$" + ref.name ||
      (ref.start > 0 && !/\s/.test(value[ref.start - 1]!)) || (ref.end < value.length && !/[\s.,!?;，。！？；]/.test(value[ref.end]!))) continue;
    result.push({ skillId: ref.skillId, source: ref.source, ...(ref.source === "agent" ? { backendId: ref.backendId } : {}), name: ref.name, start: ref.start, end: ref.end } as SkillReference);
  }
  return result.sort((a, b) => a.start - b.start).filter((ref, index, refs) => index === 0 || ref.start >= refs[index - 1]!.end);
}

/** Edits retain identity only for untouched ranges; never look up a same-name occurrence. */
export function syncSkillReferences(before: string, after: string, refs: readonly SkillReference[], edit?: PromptEdit): SkillReference[] {
  if (before === after && !edit) return validSkillReferences(after, refs);
  let retained = validSkillReferences(before, refs);
  if (!edit || before.slice(0, edit.start) + edit.text + before.slice(edit.end) !== after) {
    retained = retained.filter(ref => {
      const token = "$" + ref.name;
      const occurrences = (text: string) => text.split(token).length - 1;
      return occurrences(before) <= 1 || occurrences(before) === occurrences(after);
    });
    let start = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    let end = before.length, nextEnd = after.length;
    while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
    edit = { start, end, text: after.slice(start, nextEnd) };
  }
  const delta = edit.text.length - (edit.end - edit.start);
  return validSkillReferences(after, retained.flatMap(ref =>
    ref.end <= edit.start ? [ref] : ref.start >= edit.end ? [{ ...ref, start: ref.start + delta, end: ref.end + delta }] : []));
}

export const VISUALIZE_FEATURE_MENTION = '[visualize](workgraph-feature:visualize)';

export function extractBuiltinFeatureMention(link: string) {
  return link === VISUALIZE_FEATURE_MENTION ? { name: 'visualize', kind: 'builtin-feature' as const } : undefined;
}

/** Explicit feature tokens stay in sync with the structured execution setting. */
export function syncBuiltinFeatureMentions(previous: string, next: string, features: VisualizeFeatureSelection[]): VisualizeFeatureSelection[] {
  const selected = features.filter(feature => feature.featureId !== VISUALIZE_FEATURE_ID);
  if (next.includes(VISUALIZE_FEATURE_MENTION)) selected.push({ kind: 'builtin-feature', featureId: VISUALIZE_FEATURE_ID, version: 1 });
  else if (!previous.includes(VISUALIZE_FEATURE_MENTION)) return features;
  return selected;
}
