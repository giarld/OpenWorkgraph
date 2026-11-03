import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '@openworkgraph/protocol';
import type { AgentHistoryContext } from '../contracts.js';
import { AgentError } from '../errors.js';
import { builtinAttemptDirectory } from './recovery.js';
import { BUILTIN_AGENT_LIMITS } from './limits.js';

/** Called only by the authorized host history reader. Private journal files
 * are never exposed as paths to a model or added to visible progress records. */
export async function readBuiltinHistory(context: AgentHistoryContext): Promise<readonly Json[]> {
  const directory = builtinAttemptDirectory(await realpath(context.serviceRoot), context.runId, context.attemptId);
  try {
    if (await realpath(directory) !== directory) throw new AgentError('permission_denied');
    const file = await open(join(directory, 'history.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > BUILTIN_AGENT_LIMITS.historyBytes) throw new AgentError('invalid_configuration');
      const bytes = Buffer.alloc(info.size); let size = 0;
      while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
      // A live append can be read again after it settles; do not return torn JSON.
      const after = await file.stat();
      if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new AgentError('outcome_unknown');
      const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
      if (text && !text.endsWith('\n')) throw new AgentError('outcome_unknown');
      return text.split('\n').filter(Boolean).map(line => {
        const value = JSON.parse(line) as Record<string, Json>;
        if (!value || Array.isArray(value) || value.runId !== context.runId || value.attemptId !== context.attemptId || typeof value.type !== 'string' || typeof value.at !== 'string') throw new AgentError('invalid_configuration');
        return value;
      });
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error instanceof AgentError ? error : new AgentError('invalid_configuration', '原始运行历史当前不可读取。');
  }
}
