import { canonicalJson } from '../../persistence/repositories.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentForm, AgentFormValue } from '@openworkgraph/protocol';
import type { BackendCallbacks, BackendInteraction, BackendReply } from '../../backend/types.js';
import { AgentError } from '../errors.js';
import { validateAgentForm, validateAgentFormAnswer } from '../forms.js';
import type { OpenCodeTransport } from './transport.js';
type Native = Record<string, any>;
interface Pending { id: string; sessionId: string; nativeId: string; kind: 'form' | 'permission'; value: Native; interaction: BackendInteraction; fingerprint: string; gone: boolean }
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value as import('@openworkgraph/protocol').Json)).digest('hex');

/** Session-scoped FIFO. Native global forms are deliberately not assigned to
 * the latest Run. Delivery intents precede sends; unknown sends are reconciled
 * against the original request and never automatically repeated. */
export class OpenCodeInteractions {
  private readonly db: DatabaseSync;
  private readonly entries = new Map<string, Pending>();
  private published: string | undefined;
  private cancelled = false;
  constructor(private readonly transport: OpenCodeTransport, directory: string, private readonly automatic: boolean, private readonly callbacks: BackendCallbacks, private readonly redact: (value: string) => string, private readonly exclusiveLocation?: string) {
    const path = join(directory, 'interactions.sqlite'); this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reply (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0);');
  }
  get pending(): boolean { return [...this.entries.values()].some(entry => !entry.gone); }
  private formPath(entry: Pending, action = '') {
    return '/api/session/' + entry.sessionId + '/form/' + entry.nativeId + action + (entry.sessionId === 'global' && this.exclusiveLocation ? '?location%5Bdirectory%5D=' + encodeURIComponent(this.exclusiveLocation) : '');
  }
  private entry(sessionId: string, value: Native, kind: Pending['kind']): Pending {
    if (typeof value.id !== 'string' || value.id.length > 200 || kind === 'form' && value.sessionID !== sessionId) throw new AgentError('protocol_error');
    const id = 'opencode-' + digest([sessionId, kind, value.id]).slice(0, 32), fingerprint = digest(value);
    const old = this.entries.get(id); if (old) { if (old.fingerprint !== fingerprint) throw new AgentError('protocol_error'); return old; }
    if (this.entries.size >= 256) throw new AgentError('protocol_error');
    let interaction: BackendInteraction;
    if (kind === 'permission') {
      if (value.sessionID !== sessionId || typeof value.action !== 'string' || !Array.isArray(value.resources)) throw new AgentError('protocol_error');
      const command = value.action === 'shell' && value.resources.length ? this.redact(String(value.resources[0])).slice(0, 16000) : null;
      interaction = { id, kind: 'approval', questions: [], reason: this.redact(value.message ?? value.action).slice(0, 4096), command, canApprove: true,
        details: { version: 1, kind: command ? 'command' : 'tool', summary: this.redact(value.action), scope: 'once', ...(command ? { command } : {}) } };
    } else {
      if (!Array.isArray(value.fields) || !value.fields.length || value.fields.length > 32) throw new AgentError('protocol_error');
      const nativeOnly = value.fields.some((field: Native) => field.type === 'external' || field.hidden === true) || this.redact(JSON.stringify(value.fields)) !== JSON.stringify(value.fields);
      const form: AgentForm = nativeOnly ? { version: 1, fields: [{ key: 'native', type: 'external', actionId: id }] }
        : validateAgentForm({ version: 1, fields: value.fields });
      // Existing question clients require an answer to every field. Optional
      // native fields must remain typed Forms so omission keeps its meaning.
      const simple = !nativeOnly && form.fields.every(field => field.required === true && ['string', 'multiselect'].includes(field.type) && !field.when?.length && !field.format && !field.pattern && field.minLength === undefined && field.maxLength === undefined && field.minItems === undefined && field.maxItems === undefined && new Set(field.options?.map(option => option.label)).size === (field.options?.length ?? 0));
      interaction = { id, kind: 'question', reason: nativeOnly ? '此交互需要使用 OpenCode 原生认证流程。' : simple ? this.redact(String(value.title ?? '问题')) : '此类型化表单需通过 API 答复；当前 Web 未开放。', command: null, canApprove: false,
        questions: simple ? form.fields.map(field => ({ id: field.key, text: this.redact(field.title ?? field.description ?? field.key), options: (field.options ?? []).map(option => this.redact(option.label)), mode: field.type === 'multiselect' ? 'multiple' : field.options?.length ? 'single' : 'text', allowOther: !field.options?.length || field.custom === true })) : [], form };
    }
    const entry = { id, sessionId, nativeId: value.id, kind, value, interaction, fingerprint, gone: false }; this.entries.set(id, entry); return entry;
  }
  async observe(sessionIds: readonly string[]): Promise<'waiting_answer' | 'waiting_approval' | null> {
    if (this.cancelled) return null;
    const present = new Set<string>();
    for (const sessionId of sessionIds) {
      const values = await Promise.all([
        this.transport.request('/api/session/' + sessionId + '/permission'), this.transport.request('/api/session/' + sessionId + '/form'),
      ]) as Native[];
      for (const [index, response] of values.entries()) {
        if (!Array.isArray(response.data) || response.data.length > 128) throw new AgentError('protocol_error');
        for (const value of response.data) {
          const entry = this.entry(sessionId, value, index === 0 ? 'permission' : 'form'); present.add(entry.id);
          if (this.automatic && entry.kind === 'permission') await this.respond(entry.id, { kind: 'approval', decision: 'accept' });
        }
      }
    }
    if (this.exclusiveLocation) {
      // The authenticated instance and its sole frozen Location belong to this
      // Run. Preserve native GLOBAL scope; never assign it to a guessed or
      // newest Session. Other global forms remain unsupported.
      const response = await this.transport.request('/api/form?location%5Bdirectory%5D=' + encodeURIComponent(this.exclusiveLocation)) as Native;
      if (response.location?.directory !== this.exclusiveLocation || !Array.isArray(response.data) || response.data.length > 128) throw new AgentError('protocol_error');
      for (const value of response.data) if (value.sessionID === 'global') {
        if (value.metadata?.kind !== 'mcp-elicitation' || typeof value.metadata.server !== 'string') throw new AgentError('capability_unsupported');
        const entry = this.entry('global', value, 'form'); present.add(entry.id);
      }
    }
    for (const entry of this.entries.values()) if (!entry.gone && !present.has(entry.id)) {
      if (this.published === entry.id) { await this.callbacks.onInteractionCancelled?.(entry.id); this.published = undefined; }
      entry.gone = true;
    }
    const next = [...this.entries.values()].find(entry => !entry.gone);
    if (next && this.published !== next.id) {
      // Commit delivery only after the host has accepted it. A failed callback
      // must leave this FIFO entry eligible for the next observation.
      await this.callbacks.onInteraction(next.interaction);
      if (!this.cancelled && !next.gone) this.published = next.id;
    }
    if (this.cancelled) return null;
    return next ? next.kind === 'permission' ? 'waiting_approval' : 'waiting_answer' : null;
  }
  async respond(id: string, reply: BackendReply): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.gone && !this.automatic && this.published !== id || this.cancelled) throw new AgentError('outcome_unknown');
    let payload: unknown;
    if (entry.kind === 'permission') {
      if (reply.kind !== 'approval') throw new AgentError('invalid_configuration');
      payload = { decision: reply.decision === 'accept' ? 'once' : 'reject' };
    } else {
      if (entry.interaction.form?.fields.some(field => field.type === 'external')) throw new AgentError('capability_unsupported');
      let values: Record<string, AgentFormValue>;
      if (reply.kind === 'form') values = validateAgentFormAnswer(entry.interaction.form, reply.values);
      else if (reply.kind === 'question' && entry.interaction.questions.length) {
        values = Object.create(null);
        for (const field of entry.interaction.form!.fields) {
          const answers = reply.answers[field.key]; if (!Array.isArray(answers) || !answers.length) throw new AgentError('invalid_configuration');
          const mapped = answers.map(value => field.options?.find(option => this.redact(option.label) === value)?.value ?? value);
          values[field.key] = field.type === 'multiselect' ? mapped : mapped.length === 1 ? mapped[0]! : (() => { throw new AgentError('invalid_configuration'); })();
        }
        values = validateAgentFormAnswer(entry.interaction.form, values);
      } else throw new AgentError('invalid_configuration');
      payload = { answer: values };
    }
    await this.deliver(entry, payload);
  }
  /** External URLs are returned only by an explicit authenticated operation,
   * never as ordinary answers, snapshots, history or model tool arguments. */
  async external(id: string, confirm: boolean): Promise<import('@openworkgraph/protocol').Json> {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== 'form' || this.cancelled || !entry.value.fields.every((field: Native) => field.type === 'external' && typeof field.url === 'string')) throw new AgentError('capability_unsupported');
    if (confirm) {
      if (this.published !== id && !this.db.prepare('SELECT 1 FROM reply WHERE id=?').get(id)) throw new AgentError('outcome_unknown');
      const answer: Record<string, boolean> = Object.create(null);
      for (const field of entry.value.fields) answer[field.key] = true;
      await this.deliver(entry, { answer }); return { confirmed: true };
    }
    if (entry.gone || this.published !== id) throw new AgentError('outcome_unknown');
    const detail = await this.transport.request(this.formPath(entry)) as Native;
    if (detail.data?.state?.status !== 'pending') throw new AgentError('outcome_unknown');
    return { actions: entry.value.fields.map((field: Native) => {
      const url = new URL(field.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AgentError('capability_unsupported');
      return { url: url.href };
    }) };
  }
  private async deliver(entry: Pending, payload: unknown): Promise<void> {
    const id = entry.id;
    const fingerprint = digest(payload), previous = this.db.prepare('SELECT fingerprint,acknowledged FROM reply WHERE id=?').get(id);
    if (previous && previous.fingerprint !== fingerprint) throw new AgentError('outcome_unknown');
    if (!previous) {
      if (entry.gone) throw new AgentError('outcome_unknown');
      this.db.prepare('INSERT INTO reply VALUES (?,?,0)').run(id, fingerprint);
      try {
        await this.transport.request(entry.kind === 'form' ? this.formPath(entry, '/reply') : '/api/session/' + entry.sessionId + '/permission/' + entry.nativeId + '/reply', { method: 'POST', body: payload });
        this.db.prepare('UPDATE reply SET acknowledged=1 WHERE id=?').run(id);
      } catch { /* Inspect original native state; never resend. */ }
    }
    if (entry.kind === 'form') {
      const detail = (await this.transport.request(this.formPath(entry))) as Native;
      if (detail.data?.state?.status !== 'answered' || digest({ answer: detail.data.state.answer }) !== fingerprint) throw new AgentError('outcome_unknown');
    } else {
      const pending = await this.transport.request('/api/session/' + entry.sessionId + '/permission') as Native;
      const accepted = this.db.prepare('SELECT acknowledged FROM reply WHERE id=?').get(id);
      if (accepted?.acknowledged !== 1 || !Array.isArray(pending.data) || pending.data.some((value: Native) => value.id === entry.nativeId)) throw new AgentError('outcome_unknown');
    }
    entry.gone = true;
    if (this.published === id) this.published = undefined;
  }
  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const entry of this.entries.values()) if (!entry.gone) { await this.callbacks.onInteractionCancelled?.(entry.id); entry.gone = true; }
    this.published = undefined;
  }
  close(): void { this.db.close(); }
}
