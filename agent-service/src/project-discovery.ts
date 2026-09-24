import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ProjectCandidates, ProjectCandidate } from '@openworkgraph/protocol';
const MAX_BYTES = 2 * 1024 * 1024;
/** Best-effort private desktop format; not a public Codex RPC or a trusted registration. */
export function discoverProjects(codexHome = process.env['CODEX_HOME'] || join(homedir(),'.codex')): ProjectCandidates {
  const unavailable = (reason: string): ProjectCandidates => ({source:'codex-desktop-saved-roots',status:'unavailable',reason,candidates:[]});
  let fd: number | undefined;
  let data: unknown;
  try {
    fd = openSync(join(codexHome,'.codex-global-state.json'),constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return unavailable('Codex 桌面目录来源不是常规文件或超过读取上限；请手动输入路径。');
    const raw = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < raw.length) { const bytes = readSync(fd,raw,length,raw.length-length,null); if (!bytes) break; length += bytes; }
    if (length > MAX_BYTES) return unavailable('Codex 桌面目录来源超过读取上限；请手动输入路径。');
    data = JSON.parse(raw.subarray(0,length).toString('utf8'));
  } catch { return unavailable('Codex 桌面已保存目录来源不存在、不可读或格式无效；请手动输入路径。'); }
  finally { if (fd !== undefined) closeSync(fd); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable('Codex 桌面目录来源格式不受支持；请手动输入路径。');
  const roots = (data as Record<string,unknown>)['electron-saved-workspace-roots'];
  if (!Array.isArray(roots) || roots.length > 1000 || roots.some(value => typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 32768)) return unavailable('Codex 桌面已保存目录字段缺失或格式不受支持；请手动输入路径。');
  const seen = new Set<string>();
  const candidates: ProjectCandidate[] = [];
  for (const root of roots as string[]) {
    let path = root;
    let availability: ProjectCandidate['availability'] = 'unavailable';
    try { path = realpathSync.native(root); if (statSync(path).isDirectory()) availability = 'available'; } catch { /* Keep stale paths visible without inventing availability. */ }
    if (!seen.has(path)) { seen.add(path); candidates.push({path,availability}); }
  }
  return {source:'codex-desktop-saved-roots',status:'available',reason:'已读取本机 Codex 桌面私有格式的已保存目录；候选仅供选择，注册时仍须验证。',candidates};
}
