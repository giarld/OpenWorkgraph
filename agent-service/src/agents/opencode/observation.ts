import { AgentError } from '../errors.js';

type Native = Record<string, any>;
/** History records contain text and metadata; resources have independent
 * storage/limits and must be removed before the record's byte budget applies. */
export function openCodeHistoryMessage(message: Native): Native {
  return { id: message.id, type: message.type, time: message.time,
    ...(message.type === 'assistant' && message.time?.completed ? { text: (message.content ?? []).filter((part: Native) => part.type === 'text').map((part: Native) => part.text).join('\n') } : {}) };
}
/** Polling needs message identity, usage and public text, never image data,
 * tool arguments/results or reasoning. Project inside the private worker so
 * large native transcripts cannot block completion or cancellation checks. */
export function openCodeObservationMessages(messages: Native[]): Native[] {
  if (!Array.isArray(messages) || messages.length > 2048) throw new AgentError('protocol_error');
  return messages.filter(message => ['assistant', 'compaction'].includes(message.type)).map(message => ({
    id: message.id, type: message.type,
    ...(message.time ? { time: { completed: message.time.completed } } : {}),
    ...(message.error ? { error: { status: message.error.status } } : {}),
    ...(message.tokens ? { tokens: { input: message.tokens.input, output: message.tokens.output, reasoning: message.tokens.reasoning,
      ...(message.tokens.cache ? { cache: { read: message.tokens.cache.read, write: message.tokens.cache.write } } : {}) } } : {}),
    content: (message.content ?? []).filter((part: Native) => ['text', 'tool'].includes(part.type))
      .map((part: Native) => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'tool' }),
  }));
}
