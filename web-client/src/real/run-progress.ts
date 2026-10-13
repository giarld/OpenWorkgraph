import type { Json } from '../../../packages/protocol/src/index';
import type { AgentMessageIdentity } from '../../../packages/protocol/src/agents';
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
/** New public identities need no native session/turn. Legacy records remain readable. */
function messageIdentity(payload: Record<string, Json>, summary: Record<string, Json>): string | null {
  const explicit = summary.identity ?? payload.identity;
  if ((summary.identity !== undefined || payload.identity !== undefined) && !object(explicit)) return null;
  const identity = object(explicit) ?? {
    backendId: summary.backendId ?? payload.backendId, attemptId: summary.attemptId ?? payload.attemptId,
    messageId: summary.messageId ?? payload.messageId,
  };
  const fields: (keyof AgentMessageIdentity)[] = ['backendId', 'attemptId', 'messageId'];
  const identifier = (value: Json | undefined) => typeof value === 'string' && !!value.trim() && value.length <= 200 && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (fields.every(key => identifier(identity[key]))) {
    if (summary.messageId !== undefined && summary.messageId !== identity.messageId) return null;
    return JSON.stringify(['agent', ...fields.map(key => identity[key])]);
  }
  // Partial or invalid new identities must not fall back and collide with old records.
  if (explicit !== undefined || fields.some(key => identity[key] !== undefined)) return null;
  return [payload.threadId, payload.turnId, summary.itemId].every(value => typeof value === 'string' && value.trim())
    ? JSON.stringify(['legacy', payload.threadId, payload.turnId, summary.itemId]) : null;
}
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
      const details = object(payload?.errorDetails);
      if (to === 'failed' && payload?.errorCode === 'INPUT_BLOCKED' &&
        ['FORM_REQUIRED', 'FORM_INVALID'].includes(String(details?.visualizeCode)) && Array.isArray(details?.fields)) {
        for (const [index, value] of details.fields.entries()) {
          const field = object(value);
          if (!field || typeof field.path !== 'string' || typeof field.message !== 'string') continue;
          // Each field needs its own React key; only public validation data is shown.
          push('message', translate('Form field {path}: {message}', { path: field.path || '/', message: field.message }));
          result[result.length - 1]!.key = `${record.id}:field:${index}`;
        }
      }
      continue;
    }
    if (record.kind !== 'backend.progress') continue;
    const payload = object(record.payload); if (!payload) continue;
    const state = typeof payload.state === 'string' ? payload.state : '';
    if (Object.hasOwn(states, state)) pushState(translate(states[state]));
    const summary = object(payload.summary);
    if (!summary || summary.source !== 'agentMessage' || !['commentary', 'final_answer'].includes(String(summary.phase)) ||
      typeof summary.text !== 'string' || !summary.text.trim()) continue;
    const key = messageIdentity(payload, summary);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key); push('message', summary.text);
  }
  return { entries: result, omitted };
}
