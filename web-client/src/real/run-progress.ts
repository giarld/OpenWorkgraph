import type { Json } from '../../../packages/protocol/src/index';
import '../i18n/catalogs/runs';
import { translate } from '../i18n/translate';
import { displayTerminology } from '../i18n/display-terminology';

export interface RunProgressHistory {
  historyState: 'retained' | 'cleared';
  records: { id: number; occurredAt: string; kind: string; payload: Json }[];
}
export interface RunProgressEntry {
  /** A single history record can produce both a state and a message entry. */
  key: string; recordId: number; occurredAt: string; kind: 'state' | 'message' | 'event'; text: string;
}
const states: Record<string, string> = {
  starting: 'Starting', running: 'Executing', waiting_answer: 'Waiting for answer',
  waiting_approval: 'Waiting for approval', cancelling: 'Cancelling', completed: 'Agent execution finished, awaiting delivery confirmation',
  failed: 'Agent execution failed', cancelled: 'Agent confirmed stopping', unknown: 'Execution result pending verification',
};
const object = (value: Json | undefined) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const runStates: Record<string, string> = {
  accepted: 'Run request accepted', queued: 'Entered queue', preparing: 'Preparing input', running: 'Executing',
  waiting_answer: 'Waiting for answer', waiting_approval: 'Waiting for approval', cancelling: 'Cancelling',
  agent_completed: 'Agent execution finished, awaiting delivery confirmation', finalizing: 'Saving delivery output',
  succeeded: 'Run succeeded and delivery was saved', failed: 'Run failed', cancelled: 'Run cancelled',
  interrupted: 'Run interrupted', reconciling: 'Verifying execution result', paused_restore: 'Paused after restore, waiting to continue',
};
const events: Record<string, string> = {
  'interaction.reply': 'Interaction reply submitted, waiting for Workspace confirmation',
  'generation.accepted': 'Generated candidate accepted', 'generation.discarded': 'Generated candidate discarded',
  'scheduler.error': 'A scheduling error occurred. Check the run status.', 'reconcile.error': 'Execution result verification failed. The result is still pending confirmation.',
};

/** Feed the selected service/Run's GET /v1/runs/:id/history response to RunSummary.
 * Refresh while active: backend.progress is durable history, not a run.changed SSE event.
 * Missing/cleared history stays empty; never serialize arbitrary payloads as summaries. */
export function runProgressSummaries(history: RunProgressHistory | null | undefined): string[] {
  return runProgressEntries(history).map(entry => entry.text);
}

/** Keep the always-mounted Work Graph node small; the run details retain full history. */
export function runProgressPreview(history: RunProgressHistory | null | undefined): string[] {
  const { entries, omitted } = parseProgressEntries(history, 40, 2000);
  const texts = entries.map(entry => entry.text);
  return omitted ? [translate("Earlier progress or full messages are available in run details."), ...texts] : texts;
}

/** Human-readable detail rows from known event shapes, without raw diagnostic payloads. */
export function runProgressEntries(history: RunProgressHistory | null | undefined): RunProgressEntry[] {
  return parseProgressEntries(history).entries;
}

function parseProgressEntries(history: RunProgressHistory | null | undefined, maxEntries = Infinity, maxTextLength = Infinity) {
  const result: RunProgressEntry[] = [];
  if (history?.historyState !== 'retained') return { entries: result, omitted: false };
  const seen = new Set<string>(); let lastState = ''; let omitted = false;
  const records = history.records.every((record, index) => index === 0 || history.records[index - 1]!.id <= record.id)
    ? history.records : [...history.records].sort((a, b) => a.id - b.id);
  for (const record of records) {
    const push = (kind: RunProgressEntry['kind'], text: string) => {
      if (text.length > maxTextLength) { text = text.slice(0, maxTextLength) + "…"; omitted = true; }
      result.push({ key: `${record.id}:${kind}`, recordId: record.id, occurredAt: record.occurredAt, kind, text });
      if (result.length > maxEntries) { result.shift(); omitted = true; }
    };
    const pushState = (label: string | undefined) => { if (label && label !== lastState) { push('state', label); lastState = label; } };
    if (Object.hasOwn(events, record.kind)) { push('event', translate(events[record.kind]!)); continue; }
    if (record.kind === 'state') {
      const payload = object(record.payload);
      const to = payload?.to;
      if (typeof to === 'string' && Object.hasOwn(runStates, to)) pushState(translate(runStates[to]));
      if (to === 'failed' && typeof payload?.reason === 'string' && payload.reason.trim()) push('message', translate('Failure reason: {reason}', { reason: displayTerminology(payload.reason.trim()) }));
      continue;
    }
    if (record.kind !== 'backend.progress') continue;
    const payload = object(record.payload); if (!payload) continue;
    const state = typeof payload.state === 'string' ? payload.state : '';
    if (Object.hasOwn(states, state)) pushState(translate(states[state]));
    const summary = object(payload.summary);
    if (!summary || summary.source !== 'agentMessage' || !['commentary', 'final_answer'].includes(String(summary.phase)) ||
      typeof summary.itemId !== 'string' || !summary.itemId || typeof summary.text !== 'string' || !summary.text.trim() ||
      typeof payload.threadId !== 'string' || typeof payload.turnId !== 'string') continue;
    const key = JSON.stringify([payload.threadId, payload.turnId, summary.itemId]);
    if (seen.has(key)) continue;
    seen.add(key); push('message', summary.text);
  }
  return { entries: result, omitted };
}
