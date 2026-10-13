import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { realpath, stat, access } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { isSkillName } from '@openworkgraph/protocol';
import type { FrozenSkill } from '@openworkgraph/protocol';
import type { AgentQueryContext } from '../contracts.js';
import { AgentError } from '../errors.js';
import { publicText } from '../configuration.js';
import { codexQuery, type CodexPluginOptions } from '../codex.js';
import { connect } from '../../backend/capabilities.js';

interface NativeSkill { skillId: string; name: string; description: string; path: string }
/** Opaque stable public identity; paths are resolved again on this device. */
const identity = (path: string) => 'codex-' + createHash('sha256').update(path).digest('hex');
async function catalog(options: CodexPluginOptions, context: AgentQueryContext): Promise<NativeSkill[]> {
  return codexQuery(options, context, async rpc => {
    await connect(rpc);
    const value = await rpc.request('skills/list', { cwds: [context.projectPath ?? options.cwd ?? process.cwd()], forceReload: false });
    if (!Array.isArray(value?.data)) throw new AgentError('protocol_error');
    const result = new Map<string, NativeSkill>();
    for (const entry of value.data) {
      if (!Array.isArray(entry?.skills)) throw new AgentError('protocol_error');
      for (const raw of entry.skills) {
        if (raw?.enabled === false) continue;
        if (!raw || !isSkillName(raw.name) || typeof raw.path !== 'string' || !isAbsolute(raw.path) || basename(raw.path) !== 'SKILL.md') continue;
        context.signal.throwIfAborted();
        try {
          const path = await realpath(raw.path); const info = await stat(path);
          if (!info.isFile() || info.size > 128 * 1024) continue;
          await access(path);
          const description = typeof raw.description === 'string' && publicText(raw.description, 4096) ? raw.description : '';
          result.set(identity(path), { skillId: identity(path), name: raw.name, description, path });
        } catch { /* Unreadable native entries are not executable candidates. */ }
        if (result.size > 512) throw new AgentError('protocol_error');
      }
    }
    context.signal.throwIfAborted(); return [...result.values()];
  });
}
export async function codexNativeSkills(options: CodexPluginOptions, context: AgentQueryContext) {
  return (await catalog(options, context)).map(({ skillId, name, description }) => ({ skillId, name, description }));
}
export async function resolveCodexSkills(skills: readonly FrozenSkill[], cwd: string, options: CodexPluginOptions, signal: AbortSignal): Promise<FrozenSkill[]> {
  if (skills.some(skill => skill.source === 'agent' && skill.backendId !== 'codex')) throw new AgentError('invalid_configuration');
  const hooks: (() => void | Promise<void>)[] = [];
  let native: NativeSkill[] = [];
  try {
    if (skills.some(skill => skill.source === 'agent')) native = await catalog({ ...options, cwd }, { projectPath: cwd, options: {}, platform: process.platform as AgentQueryContext['platform'], signal, deferCleanup: hook => hooks.push(hook) });
    return await Promise.all(skills.map(async skill => {
      signal.throwIfAborted();
      if (skill.source === 'openworkgraph') {
        if (!isAbsolute(skill.path) || basename(skill.path) !== 'SKILL.md') throw new AgentError('invalid_configuration');
        await access(skill.path); return structuredClone(skill);
      }
      if (skill.source === 'codex') {
        if (!isSkillName(skill.name) || !isAbsolute(skill.path) || basename(skill.path) !== 'SKILL.md') throw new AgentError('invalid_configuration');
        const path = await realpath(skill.path), info = await stat(path);
        if (skill.path !== path || skill.skillId !== 'codex:' + path || !info.isFile() || info.size > 128 * 1024) throw new AgentError('invalid_configuration');
        await access(path, constants.R_OK); signal.throwIfAborted();
        return structuredClone(skill);
      }
      const item = native.find(item => skill.skillId === item.skillId);
      if (!item || item.name !== skill.name || skill.path && skill.path !== item.path) throw new AgentError('invalid_configuration');
      return { ...structuredClone(skill), path: item.path };
    }));
  } finally { await Promise.all(hooks.map(hook => hook())); }
}
