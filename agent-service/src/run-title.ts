import { limitNodeTitle } from '@openworkgraph/protocol';

export const DEFAULT_EXECUTION_TITLES = new Set(['执行任务', 'Execution task']);

/** Immediate title for backends without an early agent title (including API images). */
export function promptRunTitle(prompt: string): string | undefined {
  const line = prompt.split(/\r?\n/).find(part => part.trim())?.trim() ?? '';
  const first = line.replace(/^#{1,6}\s+/, '').split(/[。！？.!?]/, 1)[0]!.trim();
  const title = limitNodeTitle(first.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  return title && !DEFAULT_EXECUTION_TITLES.has(title) ? title : undefined;
}
