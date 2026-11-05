import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentForm, AgentFormField, AgentFormValue } from '@openworkgraph/protocol';
import type { BackendCallbacks, BackendInteraction, BackendReply } from '../../backend/types.js';
import { AgentError } from '../errors.js';
import { validateAgentForm, validateAgentFormAnswer } from '../forms.js';
import type { AcpObject, AcpRequest, OpenCodeAcp } from './acp.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: any): value is AcpObject => !!value && typeof value === 'object' && !Array.isArray(value);
function options(value: any): { value: string; label: string; description?: string }[] {
  if (!Array.isArray(value)) throw new AgentError('capability_unsupported');
  return value.map(item => {
    if (typeof item === 'string') return { value: item, label: item };
    if (!object(item) || typeof item.const !== 'string' || item.title !== undefined && typeof item.title !== 'string' || Object.keys(item).some(key => !['const', 'title', 'description'].includes(key))) throw new AgentError('capability_unsupported');
    return { value: item.const, label: item.title ?? item.const, ...(item.description === undefined ? {} : { description: item.description }) };
  });
}
/** Reject unrepresentable schemas rather than dropping constraints, optional
 * fields, enum identities, or filling in answers on behalf of the user. */
export function acpForm(schema: unknown): AgentForm {
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties) || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties', '$schema'].includes(key)) || schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new AgentError('capability_unsupported');
  const required: string[] = schema.required ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)) || new Set(required).size !== required.length) throw new AgentError('protocol_error');
  const fields = Object.entries(schema.properties).map(([key, property]): AgentFormField => {
    if (!object(property)) throw new AgentError('protocol_error');
    const supported = ['type', 'title', 'description', 'default', 'enum', 'oneOf', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems'];
    if (Object.keys(property).some(key => !supported.includes(key))) throw new AgentError('capability_unsupported');
    const field: AcpObject = { key, type: property.type, required: required.includes(key) };
    for (const name of ['title', 'description', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems']) if (property[name] !== undefined) field[name] = property[name];
    if (property.type === 'array') {
      if (!object(property.items) || Object.keys(property.items).some(key => !['type', 'enum', 'anyOf', 'oneOf'].includes(key)) || property.items.type !== undefined && property.items.type !== 'string') throw new AgentError('capability_unsupported');
      field.type = 'multiselect'; field.options = options(property.items.enum ?? property.items.anyOf ?? property.items.oneOf);
    } else if (property.oneOf !== undefined || property.enum !== undefined) field.options = options(property.oneOf ?? property.enum);
    return field as AgentFormField;
  });
  return validateAgentForm({ version: 1, fields });
}
interface Entry { request: AcpRequest; interaction: BackendInteraction; accept?: string; reject?: string; done: boolean; published: boolean; withdrawing?: boolean; replying?: Promise<void> }
export class OpenCodeAcpInteractions {
  private entries: Entry[] = [];
  private db: DatabaseSync;
  private cancelled = false;
  private publishing = false;
  private publishAgain = false;
  constructor(private readonly rpc: OpenCodeAcp, directory: string, private readonly automatic: boolean,
    private readonly callbacks: BackendCallbacks, private readonly active: () => boolean,
    private readonly redact: (value: string) => string, private readonly changed: () => void | Promise<void>) {
    const path = join(directory, 'acp-interactions.sqlite'); this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reply(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,sent INTEGER NOT NULL);');
  }
  get state(): 'waiting_approval' | 'waiting_answer' | null {
    const entry = this.entries.find(entry => !entry.done);
    return entry ? entry.interaction.kind === 'approval' ? 'waiting_approval' : 'waiting_answer' : null;
  }
  async receive(request: AcpRequest): Promise<void> {
    if (this.cancelled || !this.active()) { await this.rpc.respond(request.id, { code: -32800, message: 'Task is no longer accepting work.' }, true); return; }
    const value = request.params, id = 'opencode-' + digest([value.sessionId, request.method, request.id]).slice(0, 32);
    if (typeof value.sessionId !== 'string' || !/^ses_[A-Za-z0-9_-]+$/.test(value.sessionId)) throw new AgentError('protocol_error');
    const prior = this.entries.find(entry => entry.request.id === request.id);
    if (prior) { if (digest(prior.request) !== digest(request)) throw new AgentError('protocol_error'); await this.publish(); return; }
    let entry: Entry;
    if (request.method === 'session/request_permission') {
      if (!object(value.toolCall) || !Array.isArray(value.options) || value.options.length > 32) throw new AgentError('protocol_error');
      const allow = value.options.find((option: any) => option.kind === 'allow_once' && typeof option.optionId === 'string');
      const deny = value.options.find((option: any) => option.kind === 'reject_once' && typeof option.optionId === 'string');
      if (!deny) throw new AgentError('capability_unsupported');
      const raw = value.toolCall.rawInput;
      const command = object(raw) && typeof raw.command === 'string' ? this.redact(raw.command).slice(0, 16000) : null;
      const reason = this.redact(typeof value.toolCall.title === 'string' ? value.toolCall.title : '允许执行此操作？').slice(0, 4096);
      entry = { request, interaction: { id, kind: 'approval', questions: [], reason, command, canApprove: !!allow,
        details: { version: 1, kind: command ? 'command' : 'tool', summary: reason, scope: 'once', ...(command ? { command } : {}) } },
        ...(allow ? { accept: allow.optionId } : {}), reject: deny.optionId, done: false, published: false };
    } else if (request.method === 'elicitation/create') {
      if (value.mode !== 'form' || typeof value.message !== 'string') throw new AgentError('capability_unsupported');
      const form = acpForm(value.requestedSchema);
      if (this.redact(JSON.stringify(form)) !== JSON.stringify(form)) throw new AgentError('capability_unsupported');
      const simple = form.fields.every(field => field.required === true && ['string', 'multiselect'].includes(field.type) && !field.format && !field.pattern && field.minLength === undefined && field.maxLength === undefined && field.minItems === undefined && field.maxItems === undefined && new Set(field.options?.map(option => option.label)).size === (field.options?.length ?? 0));
      entry = { request, interaction: { id, kind: 'question', reason: simple ? this.redact(value.message).slice(0, 4096) : '此类型化表单需通过 API 答复；当前 Web 未开放。', command: null, canApprove: false, form,
        questions: simple ? form.fields.map(field => ({ id: field.key, text: this.redact(field.title ?? field.key), options: field.options?.map(option => option.label) ?? [], mode: field.type === 'multiselect' ? 'multiple' : field.options ? 'single' : 'text', allowOther: field.options === undefined })) : [] }, done: false, published: false };
    } else { await this.rpc.respond(request.id, { code: -32601, message: 'Method is not supported.' }, true); return; }
    if (this.entries.length >= 256) throw new AgentError('protocol_error');
    this.entries.push(entry);
    if (this.automatic && entry.accept) { await this.reply(id, { kind: 'approval', decision: 'accept' }); return; }
    await this.publish();
  }
  async publish(): Promise<void> {
    // A callback may synchronously await reply(). Do not queue that reply's
    // publication behind the callback that is waiting for it.
    if (this.publishing) { this.publishAgain = true; return; }
    this.publishing = true;
    try {
      do {
        this.publishAgain = false;
        const entry = this.entries.find(entry => !entry.done);
        await this.changed();
        if (entry && !entry.published && !this.cancelled && this.active()) {
          entry.published = true;
          try { await this.callbacks.onInteraction(structuredClone(entry.interaction)); }
          catch (error) { if (!entry.done) entry.published = false; throw error; }
        }
      } while (this.publishAgain);
    } finally { this.publishing = false; }
  }
  async reply(id: string, reply: BackendReply): Promise<void> {
    if (!this.active() || this.cancelled) throw new AgentError('outcome_unknown');
    const entry = this.entries.find(entry => entry.interaction.id === id);
    if (!entry || entry.withdrawing) throw new AgentError('outcome_unknown');
    let response: unknown;
    if (entry.interaction.kind === 'approval') {
      if (reply.kind !== 'approval' || !['accept', 'decline'].includes(reply.decision)) throw new AgentError('invalid_configuration');
      const option = reply.decision === 'accept' ? entry.accept : entry.reject;
      if (!option) throw new AgentError('capability_unsupported');
      response = { outcome: { outcome: 'selected', optionId: option } };
    } else {
      let values: Record<string, AgentFormValue>;
      if (reply.kind === 'form') values = validateAgentFormAnswer(entry.interaction.form, reply.values);
      else if (reply.kind === 'question' && entry.interaction.questions.length) {
        const answers: Record<string, AgentFormValue> = Object.create(null);
        if (Object.keys(reply.answers).some(key => !entry.interaction.form!.fields.some(field => field.key === key))) throw new AgentError('invalid_configuration');
        for (const field of entry.interaction.form!.fields) {
          const selected = reply.answers[field.key];
          if (!Array.isArray(selected) || !selected.length || field.type !== 'multiselect' && selected.length !== 1) throw new AgentError('invalid_configuration');
          const mapped = selected.map(value => field.options?.find(option => option.label === value)?.value ?? value);
          answers[field.key] = field.type === 'multiselect' ? mapped : mapped[0]!;
        }
        values = validateAgentFormAnswer(entry.interaction.form, answers);
      } else throw new AgentError('invalid_configuration');
      response = { action: 'accept', content: values };
    }
    const fingerprint = digest(response), previous = this.db.prepare('SELECT fingerprint,sent FROM reply WHERE id=?').get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AgentError('outcome_unknown');
      if (entry.replying) return entry.replying;
      if (previous.sent !== 1) throw new AgentError('outcome_unknown');
      return;
    }
    if (this.entries.find(candidate => !candidate.done) !== entry && !(this.automatic && entry.accept)) throw new AgentError('outcome_unknown');
    this.db.prepare('INSERT INTO reply VALUES(?,?,0)').run(id, fingerprint);
    entry.replying = (async () => {
      await this.rpc.respond(entry.request.id, response);
      this.db.prepare('UPDATE reply SET sent=1 WHERE id=?').run(id);
      entry.done = true; await this.publish();
    })();
    return entry.replying;
  }
  async withdraw(nativeId: unknown): Promise<void> {
    const entry = this.entries.find(entry => entry.request.id === nativeId && !entry.done);
    if (!entry) return;
    entry.withdrawing = true;
    await this.callbacks.onInteractionCancelled?.(entry.interaction.id); entry.done = true; await this.publish();
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const entry of this.entries) if (!entry.done) await this.withdraw(entry.request.id);
  }
  close() { this.db.close(); }
}
