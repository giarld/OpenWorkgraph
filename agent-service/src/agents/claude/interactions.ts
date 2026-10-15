import { createHash } from 'node:crypto';
import type { BackendInteraction, BackendReply } from '../../backend/types.js';
import { AgentError } from '../errors.js';

export type ClaudeSend = (message: unknown) => Promise<void>;
interface Pending { id: string; nativeId: string; fingerprint: string; input: Record<string, unknown>; interaction: BackendInteraction; send: ClaudeSend; questions?: string[]; done?: string; replyFingerprint?: string; replying?: Promise<void>; response?: unknown }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
export const claudeResponse = (requestId: string, response: unknown) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

/** Native permission and question requests share the host's existing FIFO.
 * Replies remain bound to their original connection, never the current default. */
export class ClaudeInteractions {
  private readonly entries = new Map<string, Pending>();
  private readonly queue: Pending[] = [];
  private cancelled = false;
  constructor(private readonly automatic: boolean, private readonly active: () => boolean, private readonly publish: (interaction: BackendInteraction | null) => Promise<void>, private readonly redact: (text: string) => string, private readonly withdrawn?: (interactionId: string) => Promise<void>) {}
  get pending(): boolean { return this.queue.length > 0; }
  async request(namespace: string, message: Record<string, unknown>, send: ClaudeSend): Promise<void> {
    if (!this.active() || this.cancelled || !text(message.request_id, 200) || !record(message.request) || message.request.subtype !== 'can_use_tool' || !text(message.request.tool_name, 200) || !record(message.request.input)) throw new AgentError('protocol_error');
    const nativeId = message.request_id, input = structuredClone(message.request.input), tool = message.request.tool_name;
    const fingerprint = JSON.stringify(message.request), key = namespace + ':' + nativeId;
    const prior = this.entries.get(key);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new AgentError('protocol_error'); if (prior.done && prior.done !== 'cancelled' && prior.response) await prior.send(claudeResponse(prior.nativeId, prior.response)); return; }
    if (this.entries.size >= 256 || Buffer.byteLength(fingerprint) > 65536) throw new AgentError('protocol_error');
    const id = 'claude-' + createHash('sha256').update(key).digest('hex').slice(0, 32);
    const question = tool === 'AskUserQuestion';
    let questions: string[] | undefined;
    let interaction: BackendInteraction;
    if (question) {
      if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4) throw new AgentError('protocol_error');
      questions = [];
      const fields = input.questions.map((value, index) => {
        if (!record(value) || !text(value.question, 16000) || !Array.isArray(value.options) || value.options.length > 16 || value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') throw new AgentError('protocol_error');
        const options = value.options.map(option => { if (!record(option) || !text(option.label, 512)) throw new AgentError('protocol_error'); return option.label; });
        if (new Set(options).size !== options.length || questions!.includes(value.question)) throw new AgentError('protocol_error');
        questions!.push(value.question);
        return { id: 'q' + index, text: this.redact(value.question), options: options.map(option => this.redact(option)), mode: value.multiSelect === true ? 'multiple' as const : options.length ? 'single' as const : 'text' as const, allowOther: true };
      });
      interaction = { id, kind: 'question', questions: fields, reason: '', command: null, canApprove: false };
    } else {
      const command = typeof input.command === 'string' ? this.redact(input.command.slice(0, 16000)) : null;
      const reason = this.redact('允许执行 ' + tool + '？');
      interaction = { id, kind: 'approval', questions: [], reason, command, canApprove: true, details: { version: 1, kind: command ? 'command' : 'tool', summary: reason, ...(command ? { command } : {}) } };
    }
    const entry: Pending = { id, nativeId, fingerprint, input, interaction, send, ...(questions ? { questions } : {}) };
    this.entries.set(key, entry);
    if (this.automatic && !question) { entry.response = { behavior: 'allow', updatedInput: input }; await send(claudeResponse(nativeId, entry.response)); entry.done = 'automatic'; return; }
    this.queue.push(entry);
    if (this.queue.length === 1) await this.publish(interaction);
  }
  async reply(id: string, reply: BackendReply): Promise<void> {
    if (!this.active() || this.cancelled) throw new AgentError('outcome_unknown');
    const fingerprint = JSON.stringify(reply);
    const previous = [...this.entries.values()].find(entry => entry.id === id);
    if (previous?.replyFingerprint) {
      if (previous.replyFingerprint !== fingerprint) throw new AgentError('outcome_unknown');
      await previous.replying; return;
    }
    const entry = this.queue[0];
    if (!entry || entry.id !== id || reply.kind !== entry.interaction.kind) throw new AgentError('outcome_unknown');
    let response: unknown;
    if (reply.kind === 'approval') {
      if (!['accept', 'decline'].includes(reply.decision)) throw new AgentError('invalid_configuration');
      response = reply.decision === 'accept' ? { behavior: 'allow', updatedInput: entry.input } : { behavior: 'deny', message: 'The user declined this operation.' };
    } else {
      if (!record(reply.answers) || Object.keys(reply.answers).length !== entry.questions!.length) throw new AgentError('invalid_configuration');
      const answers: Record<string, string> = {};
      entry.questions!.forEach((question, index) => {
        const values = reply.answers['q' + index], field = entry.interaction.questions[index]!;
        if (!Array.isArray(values) || !values.length || values.length > 64 || values.some(value => !text(value, 16000)) || field.mode !== 'multiple' && values.length !== 1 || new Set(values).size !== values.length) throw new AgentError('invalid_configuration');
        // The native question protocol accepts both option labels and free text.
        const originals = (entry.input.questions as Record<string, unknown>[])[index]!.options as { label: string }[];
        answers[question] = values.map(value => { const option = field.options.indexOf(value); return option < 0 ? value : originals[option]!.label; }).join(', ');
      });
      response = { behavior: 'allow', updatedInput: { ...entry.input, answers } };
    }
    if (entry.done && entry.done !== fingerprint) throw new AgentError('outcome_unknown');
    // Dequeue only after the write to the original native stdin completes.
    entry.replyFingerprint = fingerprint;
    entry.response = response;
    entry.replying = (async () => {
      await entry.send(claudeResponse(entry.nativeId, response));
      if (!this.active() || this.cancelled || this.queue[0] !== entry) throw new AgentError('outcome_unknown');
      entry.done = fingerprint; this.queue.shift(); await this.publish(this.queue[0]?.interaction ?? null);
    })();
    await entry.replying;
  }
  async abandon(namespace: string, nativeId: string): Promise<void> {
    const entry = this.entries.get(namespace + ':' + nativeId);
    if (!entry || entry.done) return;
    const index = this.queue.indexOf(entry); if (index < 0) return;
    this.queue.splice(index, 1); entry.done = 'cancelled';
    await this.withdrawn?.(entry.id);
    if (index === 0 && !this.cancelled && this.active()) await this.publish(this.queue[0]?.interaction ?? null);
  }
  cancel(): void { this.cancelled = true; this.queue.length = 0; }
  async abandonAll(namespace: string): Promise<void> {
    for (const [key, entry] of this.entries) if (key.startsWith(namespace + ':') && !entry.done) await this.abandon(namespace, entry.nativeId);
  }
}
