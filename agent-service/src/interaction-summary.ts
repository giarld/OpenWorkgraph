import type { Json } from '@openworkgraph/protocol';

const object = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const compact = (value: Json | undefined, limit = 160): string => {
  if (typeof value !== 'string') return '';
  const chars = Array.from(value.replace(/\s+/gu, ' ').trim());
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
};

/** Public, bounded reply content; never serialize native payloads or unknown form values. */
export function interactionReplySummary(kind: string, payload: Json, answer: Json): Json {
  const request = object(payload), reply = object(answer);
  if (kind === 'approval') {
    const details = object(request.details);
    const text = compact(details.summary) || compact(details.command) || compact(request.command) || compact(request.reason);
    const decision = typeof answer === 'boolean' ? answer ? 'accept' : 'decline' : reply.decision;
    return { kind, text, ...(decision === 'accept' || decision === 'decline' ? { decision } : {}) };
  }
  const answers = object(reply.answers);
  const pairs = Array.isArray(request.questions) ? request.questions.slice(0, 32).flatMap(value => {
    const question = object(value);
    const values = typeof question.id === 'string' ? answers[question.id] : undefined;
    if (typeof question.text !== 'string' || !Array.isArray(values) || !values.every(value => typeof value === 'string')) return [];
    return [compact(question.text, 60) + ' → ' + compact(values.slice(0, 64).map(value => compact(value)).join(' / '), 88)];
  }) : [];
  const legacyQuestion = compact(request.question, 60) || compact(request.prompt, 60);
  const text = pairs.length ? compact(pairs.join('; ')) : typeof answer === 'string'
    ? compact((legacyQuestion ? legacyQuestion + ' → ' : '') + compact(answer)) : '';
  return { kind: 'question', text };
}
