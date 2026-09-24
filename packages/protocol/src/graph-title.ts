const DEFAULT_GRAPH_TITLE_LIMIT = 1024;

function truncateTitle(value: string, length: number): string {
  let result = value.slice(0, length);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result.replace(/\s+$/u, '');
}

/** Resolve an imported graph title against every graph in the target project. */
export function importedGraphTitle(title: string, existingTitles: Iterable<string>, maxLength = DEFAULT_GRAPH_TITLE_LIMIT): string {
  const existing = new Set(existingTitles);
  if (!existing.has(title)) return title;
  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix++) {
    const marker = ` (${suffix})`;
    const base = truncateTitle(title, Math.max(0, maxLength - marker.length));
    const candidate = (base || title.slice(0, Math.max(0, maxLength - marker.length))) + marker;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('无法为导入的工作图生成唯一名称。');
}
