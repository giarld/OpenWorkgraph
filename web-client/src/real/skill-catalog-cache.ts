import type { SkillCatalog } from '../../../packages/protocol/src/skills';

const prefix = 'openworkgraph.skill-catalog.v1.';
const memory = new Map<string, Map<string, SkillCatalog>>();
const identities = new WeakMap<object, number>();
let identity = 0;

export function skillCatalogCacheOwner(client: object & { serviceId?: string }, workspaceName: string): string {
  if (client.serviceId) return prefix + client.serviceId;
  if (!identities.has(client)) identities.set(client, ++identity);
  return 'memory:' + identities.get(client) + ':' + workspaceName;
}

function entries(owner: string): Map<string, SkillCatalog> {
  let cached = memory.get(owner);
  if (cached) return cached;
  cached = new Map();
  try {
    if (owner.startsWith(prefix)) {
      const raw = localStorage.getItem(owner);
      const rows: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(rows)) for (const row of rows.slice(-12)) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        const catalog = row[1];
        if (catalog && typeof catalog.stale === 'boolean' && Array.isArray(catalog.items) && catalog.items.every((item: Record<string, unknown>) =>
          item && typeof item.skillId === 'string' && typeof item.name === 'string' && typeof item.description === 'string' && typeof item.installed === 'boolean' &&
          typeof item.directory === 'string' && item.source && typeof item.source === 'object' && typeof (item.source as Record<string, unknown>).repository === 'string')) cached.set(row[0], catalog);
      }
    }
  } catch { /* Unavailable or corrupt storage must not block the library. */ }
  memory.set(owner, cached);
  return cached;
}

const viewKey = (query: string, installedOnly: boolean) => JSON.stringify([installedOnly, query.trim().toLocaleLowerCase()]);
export function readSkillCatalogCache(owner: string | undefined, query: string, installedOnly: boolean): SkillCatalog | undefined {
  return owner ? entries(owner).get(viewKey(query, installedOnly)) : undefined;
}
export function writeSkillCatalogCache(owner: string, query: string, installedOnly: boolean, catalog: SkillCatalog): void {
  const cached = entries(owner), key = viewKey(query, installedOnly);
  cached.delete(key); cached.set(key, catalog);
  while (cached.size > 12) cached.delete(cached.keys().next().value!);
  try { if (owner.startsWith(prefix)) localStorage.setItem(owner, JSON.stringify([...cached])); } catch { /* Keep the in-memory cache when storage is full or disabled. */ }
}
export function clearSkillCatalogCache(owner: string): void {
  memory.delete(owner);
  try { if (owner.startsWith(prefix)) localStorage.removeItem(owner); } catch { /* Storage is optional. */ }
}
