import { runProgressEntries } from "./run-progress";
import { randomId } from "../adapter/random";
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { isTerminalRunStatus, normalizeApprovalPermissions, validApprovalPaths, type GraphSnapshot, type InputSnapshot, type Interaction, type Json, type Run } from '../../../packages/protocol/src/index';
import type { RunStatus } from '../../../packages/protocol/src/index';
import type { AgentApprovalDetails, AgentQuestionMode } from '../../../packages/protocol/src/agents';
import { RunProcessList } from '../components/NodeContent';
import { getNodeDefinition } from '../components/node-registry';
import { ArrowDown, Check, ChevronRight, ShieldCheck, Terminal, X } from 'lucide-react';
import { RefreshIcon } from '../components/RefreshIcon';
import './RunApproval.css';
import { ExecutionStartPanel } from './ExecutionStartPanel';
import '../i18n/catalogs/runs';
import { useI18n } from '../i18n/I18nProvider';
import { translate } from '../i18n/translate';

export interface RunsPanelProps {
  onClose?: () => void;
  mode?: 'all' | 'queue' | 'details'; selectedRunId?: string; onSelectRun?: (run: Run) => void;
  describeRun?: (run: Run) => { node: string; graph: string; project: string };
  request: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  graphs?: GraphSnapshot[];
  runs: Run[]; graphId?: string; onLocate: (run: Run) => void;
  executionInputs?: import('./ExecutionStartPanel').ExecutionInputs;
  onEditExecutionNode?: (run: Run, nodeId: string) => void;
  onChanged: () => void; onError: (e: unknown) => void; readOnly: boolean;
}
type Request = RunsPanelProps['request'];
type History = { historyState: 'retained' | 'cleared'; records: { id: number; occurredAt: string; kind: string; payload: Json }[] };
type Candidate = { baseVersion: number; content: Json; state: 'pending' | 'accepted' | 'discarded' };
type Changes = { state: 'changed' | 'unchanged' | 'unknown'; issues: Json[] };
type PublicMetadata = { imageRoute: InputSnapshot['imageRoute']; inputMode: string | null; requestId: string | null };
type Capacity = { capacity: number; occupied: number; available: number };
type Question = { id: string; text: string; options: string[]; mode: AgentQuestionMode; groupId?: string; allowOther?: boolean };
export type QuestionAnswers = Record<string, string | string[]>;
export interface RunDetailsData {
  history: History | null; snapshot: InputSnapshot | null; changes: Changes | null;
  publicMetadata: PublicMetadata | null;
  errors: string[];
  interactions: Interaction[]; active: Interaction | null; candidate: Candidate | null;
  target: { contentVersion: number; content: Json; readOnly: boolean } | null;
}
const pathFor = (run: Run, action: string) => '/v1/runs/' + encodeURIComponent(run.id) + '/' + action;
const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const object = (value: Json): { [key: string]: Json } => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const runStatusMessages: Record<RunStatus, string> = {
  accepted: 'Waiting to start', queued: 'Queued', preparing: 'Preparing', running: 'Running',
  waiting_answer: 'Waiting for answer', waiting_approval: 'Waiting for approval', agent_completed: 'Agent completed',
  finalizing: 'Publishing', cancelling: 'Confirming cancellation', reconciling: 'Checking status',
  paused_restore: 'Paused after restore', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
};

/** Reject mixed services; graph selection must never merge service queues. */
export function singleServiceRuns(runs: Run[]): Run[] {
  if (new Set(runs.map(run => run.serviceId)).size > 1) throw new Error(translate('A task queue can only contain tasks from the currently connected Workspace.'));
  return [...runs].sort((a, b) => {
    const left = BigInt(a.submissionSequence), right = BigInt(b.submissionSequence);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
export function followSubmittedRun(openRun: Run | undefined, submittedRun: Run): Run | undefined {
  if (!openRun) return submittedRun;
  return openRun.serviceId === submittedRun.serviceId
    && openRun.projectId === submittedRun.projectId
    && openRun.graphId === submittedRun.graphId
    && openRun.nodeId === submittedRun.nodeId
    ? submittedRun
    : openRun;
}
/** Show a just-submitted run before the next service snapshot includes it. */
export function runsForDetail(runs: Run[], detailRun: Run): Run[] {
  const scoped = runs.filter(run => run.serviceId === detailRun.serviceId && run.projectId === detailRun.projectId && run.graphId === detailRun.graphId && run.nodeId === detailRun.nodeId);
  return scoped.some(run => run.id === detailRun.id) ? scoped : [...scoped, detailRun];
}
export function interactionQuestions(interaction: Interaction): Question[] {
  const questions = object(interaction.payload).questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 32) return [];
  const result: Question[] = [];
  for (const value of questions) {
    const q = object(value);
    const mode = q.mode ?? (q.strict === true ? 'single' : 'text');
    if (typeof q.id !== 'string' || !q.id.trim() || q.id.length > 200 || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 16000 ||
      !Array.isArray(q.options) || q.options.length > 128 || !q.options.every(option => typeof option === 'string' && !!option.trim() && option.length <= 16000) ||
      !['text', 'single', 'multiple'].includes(String(mode)) || (q.strict === true && mode === 'text') ||
      (mode !== 'text' && (!q.options.length || new Set(q.options).size !== q.options.length)) ||
      (q.groupId !== undefined && typeof q.groupId !== 'string') || (q.allowOther !== undefined && typeof q.allowOther !== 'boolean')) return [];
    result.push({ id: q.id, text: q.text, options: q.options as string[], mode: mode as AgentQuestionMode,
      ...(typeof q.groupId === 'string' ? { groupId: q.groupId } : {}), ...(q.allowOther === true ? { allowOther: true } : {}) });
  }
  return new Set(result.map(q => q.id)).size === result.length ? result : [];
}
export function questionAnswer(interaction: Interaction, answers: QuestionAnswers): Json {
  const questions = interactionQuestions(interaction);
  const entries = questions.map(q => {
    const answer = answers[q.id];
    const values = typeof answer === 'string' ? [answer] : answer;
    if (!Array.isArray(values) || !values.length || values.length > 64 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 16000) ||
      new Set(values).size !== values.length || (q.mode !== 'multiple' && values.length !== 1) ||
      (q.mode !== 'text' && !q.allowOther && values.some(value => !q.options.includes(value)))) throw new Error(translate('Please answer every question completely (up to 16,000 characters each).'));
    return [q.id, [...values]];
  });
  if (!questions.length) throw new Error(translate('The question format is not recognized, so it cannot be submitted. Check again later or contact the Workspace administrator.'));
  return { kind: 'question', answers: Object.fromEntries(entries) };
}

const boundedText = (value: unknown, limit = 16000): value is string => typeof value === 'string' && value.length <= limit;
const pathsValid = (value: unknown): value is string[] => validApprovalPaths(value);
/** Bound legacy/unknown details before rendering, including depth and total size. */
export function boundedInteractionDetails(value: unknown): Json {
  let remaining = 32000, nodes = 256;
  const visit = (item: unknown, depth: number): Json => {
    if (--nodes < 0 || remaining <= 0 || depth > 6) return '…';
    if (typeof item === 'string') { const text = item.slice(0, Math.min(remaining, 16000)); remaining -= text.length; return text === item ? text : text + '…'; }
    if (Array.isArray(item)) return item.slice(0, 100).map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 50).map(([key, child]) => [key.slice(0, 128), visit(child, depth + 1)]));
    return item === null || typeof item === 'boolean' || typeof item === 'number' ? item : null;
  };
  return visit(value, 0);
}
export function interactionApproval(interaction: Interaction): { canApprove: boolean; details: AgentApprovalDetails | null; command: string; reason: string; display: Json } {
  const payload = object(interaction.payload);
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 16000) : '';
  const raw = payload.details;
  if (raw === undefined) {
    const command = typeof payload.command === 'string' ? payload.command : '';
    return { reason, command: command.slice(0, 16000), details: null, display: boundedInteractionDetails(payload),
      canApprove: payload.canApprove === true && !!command.trim() && boundedText(command) && !['permissions', 'file_change', 'tool'].includes(String(payload.approvalKind ?? payload.kind)) };
  }
  const details = { ...object(raw) };
  const allowed = ['version', 'kind', 'summary', 'command', 'paths', 'permissions', 'scope'];
  let valid = details.version === 1 && ['command', 'file_change', 'permissions', 'tool'].includes(String(details.kind)) &&
    boundedText(details.summary) && !!details.summary.trim() && Object.keys(details).every(key => allowed.includes(key)) &&
    (details.command === undefined || boundedText(details.command)) && (details.paths === undefined || pathsValid(details.paths)) &&
    (details.scope === undefined || ['once', 'turn'].includes(String(details.scope)));
  if (details.kind === 'command') valid &&= typeof details.command === 'string' && !!details.command.trim() && details.permissions === undefined;
  if (details.kind === 'file_change') valid &&= pathsValid(details.paths) && details.permissions === undefined;
  if (details.kind === 'permissions') {
    const permissions = normalizeApprovalPermissions(details.permissions);
    valid &&= permissions !== null && typeof details.scope === 'string' && !!details.scope.trim();
    if (permissions) details.permissions = permissions as unknown as Json;
  }
  if (details.kind === 'tool') valid &&= details.permissions === undefined;
  valid &&= JSON.stringify(raw).length <= 32000;
  return { reason, command: typeof details.command === 'string' ? details.command.slice(0, 16000) : '',
    details: valid ? details as unknown as AgentApprovalDetails : null, display: boundedInteractionDetails(raw), canApprove: payload.canApprove === true && valid };
}
export async function readRunDetails(request: Request, run: Run): Promise<RunDetailsData> {
  const errors: string[] = [];
  const read = async <T,>(path: string): Promise<T | null> => {
    try { return await request<T>(path); }
    catch (error) { errors.push(path + ': ' + (error instanceof Error ? error.message : String(error))); return null; }
  };
  const [history, snapshot, publicMetadata, changes, interactions, active, candidate] = await Promise.all([
    read<History>(pathFor(run, 'history')), read<InputSnapshot>(pathFor(run, 'snapshot')),
    read<PublicMetadata>(pathFor(run,'public-metadata')),
    read<Changes>(pathFor(run, 'input-changes')), read<Interaction[]>(pathFor(run, 'interactions')),
    read<Interaction | null>(pathFor(run, 'active-interaction')), read<Candidate | null>(pathFor(run, 'candidate')),
  ]);
  let target: RunDetailsData['target'] = null;
  if (candidate?.state === 'pending') {
    const graph = await read<GraphSnapshot>('/v1/projects/' + encodeURIComponent(run.projectId) + '/graphs/' + encodeURIComponent(run.graphId));
    if (graph) {
      if (graph.serviceId !== run.serviceId || graph.projectId !== run.projectId || graph.graphId !== run.graphId) throw new Error(translate('The candidate target Workspace or Work Graph does not match.'));
      const node = graph.nodes.find(n => n.id === run.nodeId);
      if (node) target = { contentVersion: node.contentVersion, content: node.content, readOnly: node.readOnly || graph.archived || graph.trashed };
    }
  }
  if (active && active.runId !== run.id) throw new Error(translate('The interaction does not match the current run.'));
  return { history, snapshot, publicMetadata, changes, interactions: interactions ?? [], active, candidate, target, errors };
}
export async function replyToInteraction(request: Request, run: Run, interaction: Interaction, answer: Json, idempotencyKey: string) {
  if (interaction.runId !== run.id || interaction.status !== 'pending') throw new Error(translate('This interaction has already been handled. Wait for the status to update.'));
  if (interaction.kind === 'approval' && (answer === true || object(answer).decision === 'accept') && !interactionApproval(interaction).canApprove) throw new Error(translate('The Workspace does not allow this operation to be approved. You can still decline it.'));
  return request(pathFor(run, 'reply'), { interactionId: interaction.id, epoch: interaction.epoch, expectedVersion: interaction.version, idempotencyKey, answer }, 'POST');
}
export async function decideRunCandidate(request: Request, run: Run, decision: 'accept' | 'discard', expectedContentVersion: number, idempotencyKey: string) {
  // CAS uses the body version the user reviewed, never the generation base version.
  // Do not silently rebase a conflicting decision onto a freshly fetched body.
  return request(pathFor(run, 'candidate'), { decision, expectedContentVersion, idempotencyKey }, 'POST');
}
export async function continueRestoredRun(request: Request, run: Run, idempotencyKey: string): Promise<Run> {
  if (run.status !== 'paused_restore') throw new Error(translate('Only a task paused after restore can continue.'));
  return request<Run>(pathFor(run, 'continue'), { idempotencyKey }, 'POST');
}
function JsonBlock({ value }: { value: unknown }) {
  const { t } = useI18n();
  if (Array.isArray(value)) return <ul className="run-value-list">{value.map((item, index) => <li key={index}><JsonBlock value={item}/></li>)}</ul>;
  if (value && typeof value === 'object') {
    const labels: Record<string, string> = { title: 'Title', text: 'Body', prompt: 'Prompt', message: 'Description', command: 'Command', cwd: 'Working directory', reason: 'Reason', description: 'Description', kind: 'Type', questions: 'Questions', options: 'Options', model: 'Model', reasoningEffort: 'Reasoning effort', summary: 'Summary', paths: 'Paths', permissions: 'Permissions', scope: 'Approval scope', version: 'Version' };
    return <dl className="run-value-list">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{labels[key] ? t(labels[key]) : key}</dt><dd><JsonBlock value={item}/></dd></div>)}</dl>;
  }
  return <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' }}>{display(value)}</pre>;
}
function CollapsibleRunValue({ value }: { value: unknown }) {
  const { t } = useI18n();
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const content = display(value);
  useLayoutEffect(() => {
    setExpanded(false);
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > Number.parseFloat(getComputedStyle(element).lineHeight) * 3 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content]);
  return <div className="run-candidate-value">
    <div id={contentId} ref={contentRef} className="run-candidate-preview" data-collapsed={!expanded ? 'true' : undefined}><JsonBlock value={value} /></div>
    {overflowing && <button type="button" className="run-process-toggle" aria-controls={contentId} aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>{expanded ? t('Collapse') : t('Expand')}</button>}
  </div>;
}
function RunSectionSummary({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return <summary><ChevronRight className="run-section-chevron" size={16} aria-hidden="true" /><span className="run-section-title">{children}</span><span className="run-section-expand" aria-hidden="true">{t('Expand')}</span><span className="run-section-collapse" aria-hidden="true">{t('Collapse')}</span></summary>;
}
export function RunParameters({ snapshot, run, nodes = [] }: { snapshot: InputSnapshot | null; run: Run; nodes?: Pick<GraphSnapshot['nodes'][number], 'id' | 'type' | 'content'>[] }) {
  const { t } = useI18n();
  const sources = new Map<string, string>();
  for (const reference of [...(snapshot?.resources ?? []), ...(snapshot?.projectFiles ?? [])]) {
    for (const id of reference.sourceNodeIds) if (!sources.has(id)) sources.set(id, reference.kind);
  }
  for (const reference of snapshot?.frozenVisualizeInputs ?? []) if (!sources.has(reference.sourceNodeId)) sources.set(reference.sourceNodeId, 'visualize');
  const references = [...sources].map(([id, kind]) => {
    const node = nodes.find(node => node.id === id);
    const title = node && object(node.content).title;
    return {id, type: t(getNodeDefinition(node?.type ?? kind).title), name: node ? typeof title === 'string' && title.trim() ? title : t('Untitled node') : t('Node removed')};
  });
  const route = snapshot?.imageRoute;
  const model = snapshot?.agent?.model ?? snapshot?.model;
  const agentModel = route?.type === 'api'
    ? t('Image generation API') + ' · ' + route.providerId + ' / ' + route.modelId
    : model ? (snapshot?.agent?.backendId ?? 'codex') + ' · ' + model.model + ' · ' + (model.reasoningEffort || t('Default reasoning effort'))
    : t('Snapshot model unavailable');
  return <>
    {!snapshot && <p>{t('Frozen input could not be read. It will be retried automatically.')}</p>}
    <dl className="run-parameters">
    {snapshot && <>
      <div><dt>{t('Prompt')}</dt><dd><pre>{snapshot.prompt}</pre></dd></div>
      <div><dt>{t('Reference content')}</dt><dd>
        {!references.length && <p>{t('No references')}</p>}
        {references.map(reference => <p key={reference.id}>{reference.type} · {reference.name}</p>)}
      </dd></div>
      <div><dt>{t('Agent / model / reasoning effort')}</dt><dd><p>{agentModel}</p></dd></div>
    </>}
    {isTerminalRunStatus(run.status) && <div><dt>{t('Token usage')}</dt><dd><p>{t('Input {input} · Output {output}', { input: run.tokenUsage?.input ?? 0, output: run.tokenUsage?.output ?? 0 })}</p></dd></div>}
  </dl></>;
}
export function InteractionForm({ interaction, disabled, onReply, onError }: { interaction: Interaction; disabled: boolean; onReply: (answer: Json) => void; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<QuestionAnswers>(() => Object.create(null));
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>(() => Object.create(null));
  const [autoAuthorize,setAutoAuthorize]=useState(false);
  const cliApproval=object(object(interaction.payload).cliAuthorization);
  useEffect(()=>setAutoAuthorize(false),[interaction.id,interaction.epoch]);
  const questions = interactionQuestions(interaction);
  const formId = useId();
  const approval = interactionApproval(interaction);
  let valid = false;
  try { questionAnswer(interaction, answers); valid = true; } catch { /* Incomplete answers disable submission. */ }
  useEffect(() => { setAnswers(Object.create(null)); setOtherAnswers(Object.create(null)); }, [interaction.id, interaction.epoch]);
  useEffect(() => { if (interaction.kind === 'question' && questions.length === 0) onError(new Error(t('The question format is not recognized, so it cannot be submitted. Check again later or contact the Workspace administrator.'))); }, [interaction.id, interaction.kind, questions.length, onError, t]);
  const { reason, command } = approval;
  return <section className={`interaction-box${interaction.kind === 'approval' ? ' run-approval' : ''}`} aria-label={t('Current question or approval awaiting action')}>
    {interaction.kind === 'question' ? <strong>{t('Your answer is needed')}</strong> : <header className="run-approval-heading">
      <span className="run-approval-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
      <div><strong>{t('Approval requested')}</strong><p>{t('Review the operation before deciding whether to approve it.')}</p></div>
    </header>}

    {interaction.status !== 'pending' ? <p role="status">{t('The answer was submitted and is awaiting Workspace confirmation. Later interactions are not available yet.')}</p> : interaction.kind === 'question' ? <form onSubmit={event => { event.preventDefault(); if (!disabled && valid) onReply(questionAnswer(interaction, answers)); }}>
      {questions.length === 0 && <p role="status">{t('The current question cannot be submitted. Check the notification.')}</p>}
      {questions.map(q => <fieldset key={q.id} disabled={disabled} style={{ marginBlock: 12 }}>
        <legend>{q.text}</legend>
        {q.mode === 'text' ? <>
          {!!q.options.length && <span className="muted" style={{ display: 'block' }}>{t('Optional answers: {options}', { options: q.options.join(' / ') })}</span>}
          <textarea aria-label={q.text} value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''} maxLength={16000} required
            style={{ width: '100%', minHeight: 72, boxSizing: 'border-box' }} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.value }))} />
        </> : q.options.map(option => <label key={option} style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center', gap: 8 }}>
          <input type={q.mode === 'single' ? 'radio' : 'checkbox'} name={formId + ':' + q.id} value={option}
            style={{ width: 'auto', flexShrink: 0, margin: 0 }}
            checked={Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).includes(option) : answers[q.id] === option}
            onChange={event => { const checked = event.target.checked; if (q.mode === 'single') setOtherAnswers(current => ({ ...current, [q.id]: '' })); setAnswers(current => {
              const values = Array.isArray(current[q.id]) ? current[q.id] as string[] : [];
              return { ...current, [q.id]: q.mode === 'single' ? [option] : checked ? [...values, option] : values.filter(value => value !== option) };
            }); }} />{option}
        </label>)}
        {q.allowOther && q.mode !== 'text' && <label style={{ display: 'block' }}>
          {t('Other answer')}
          <input type="text" value={otherAnswers[q.id] ?? ''} maxLength={16000} onChange={event => {
            const value = event.target.value; setOtherAnswers(current => ({ ...current, [q.id]: value }));
            setAnswers(current => { const selected = Array.isArray(current[q.id]) ? (current[q.id] as string[]).filter(item => q.options.includes(item)) : []; return { ...current, [q.id]: q.mode === 'single' ? value ? [value] : [] : [...new Set([...selected, ...(value ? [value] : [])])] }; });
          }} />
        </label>}
      </fieldset>)}
      <button className="primary-button" disabled={disabled || !valid}>{t('Submit answer')}</button>
    </form> : <>
      <div className="run-approval-body">
        {reason && <div className="run-approval-reason"><span>{t('Request reason')}</span><p>{reason}</p></div>}
        {command.trim() ? <div className="run-approval-command">
          <div className="run-approval-command-label"><Terminal size={14} aria-hidden="true" />{t('Operation to run')}</div>
          <pre tabIndex={0} aria-label={t('Full operation awaiting approval')}><code>{command}</code></pre>
        </div> : !approval.details && <p className="run-approval-note">{t('No command was provided. Expand the request details to verify the operation scope.')}</p>}
        {approval.details && <><p>{approval.details.summary}</p>{approval.details.scope && <p>{t('Approval scope')}: {approval.details.scope}</p>}</>}
        <details className="run-approval-details"><summary>{t('Request details')}</summary><JsonBlock value={approval.display} /></details>
        {!approval.canApprove && <p className="run-approval-note" role="status">{t('The Workspace does not allow this operation to be approved. You can still decline it.')}</p>}
      </div>
      <div className="run-approval-actions">
        {cliApproval.allowAuto===true&&<label className="cli-auto-authorization"><input type="checkbox" checked={autoAuthorize} disabled={disabled} onChange={event=>setAutoAuthorize(event.target.checked)}/>{t('Automatically authorize later CLI operations in this run')}</label>}
        <button type="button" className="secondary-button" disabled={disabled} onClick={() => onReply({ kind: 'approval', decision: 'decline' })}><X size={16} aria-hidden="true" />{t('Decline')}</button>
        <button type="button" className="primary-button" disabled={disabled || !approval.canApprove} onClick={() => { if (!disabled && approval.canApprove) onReply({ kind: 'approval', decision: 'accept',...(cliApproval.allowAuto===true?{autoAuthorize}: {}) }); }}><Check size={16} aria-hidden="true" />{t('Approve this operation')}</button>
      </div>
    </>}
  </section>;
}

/** Answered requests are summarized by their ordered history event instead of a separate card. */
export function visibleRunInteractions(interactions: Interaction[]): Interaction[] {
  return interactions.filter(item => item.status !== 'answered');
}

/** Keep active requests actionable and unhandled/expired requests inspectable in progress. */
export function RunInteractionRecords({ interactions, active, disabled, onReply, onError, submittedId }: {
  interactions: Interaction[]; active: Interaction | null; disabled: boolean;
  onReply: (answer: Json) => void; onError: (error: unknown) => void; submittedId?: string;
}) {
  const { t } = useI18n();
  return <div className="run-process-interactions" data-canvas-interactive data-canvas-no-zoom onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {visibleRunInteractions(interactions).filter(item => item.id !== active?.id).map(item => <details className="run-interaction-record" key={item.id}>
      <summary>{t(item.kind === 'question' ? 'Question' : 'Operation approval')} · {t({ pending: 'Pending', answered: 'Answered', expired: 'Expired' }[item.status])}</summary>
      <JsonBlock value={boundedInteractionDetails(item.payload)}/>
    </details>)}
    {active && <InteractionForm key={active.id + ':' + active.epoch} interaction={submittedId === active.id ? { ...active, status: 'answered' } : active} disabled={disabled} onReply={onReply} onError={onError}/>}
  </div>;
}

/** request is session-scoped to the same service as runs; remount on service switch. */
function CliGrantControl({run,request,disabled,onError}:{run:Run;request:Request;disabled:boolean;onError:(error:unknown)=>void}){
  const {t}=useI18n();const [enabled,setEnabled]=useState(false);const [revoking,setRevoking]=useState(false);
  useEffect(()=>{let active=true;const refresh=()=>request<{enabled:boolean}>('/v1/cli/authorizations/status/'+run.id).then(value=>{if(active)setEnabled(value.enabled);}).catch(()=>{});void refresh();const timer=setInterval(refresh,2000);return ()=>{active=false;clearInterval(timer);};},[run.id,request]);
  if(!enabled)return null;
  return <button type="button" className="secondary-button" disabled={disabled||revoking} aria-busy={revoking} onClick={()=>{setRevoking(true);void request('/v1/cli/authorizations/revoke',{runId:run.id},'POST').then(()=>setEnabled(false)).catch(onError).finally(()=>setRevoking(false));}}>{t('Revoke CLI auto authorization for this run')}</button>;
}
export function RunsPanel(props: RunsPanelProps) {
  const { t } = useI18n();
  const { request, runs, graphId, onLocate, onChanged, onError, readOnly, mode = 'all' } = props;
  let ordered: Run[] = [], scopeError = '';
  try { ordered = singleServiceRuns(runs); } catch (error) { scopeError = String(error); }
  const [selectedId, setSelectedId] = useState('');
  const selected = ordered.find(run => run.id === (props.selectedRunId || selectedId)) ?? ordered.filter(run => !graphId || run.graphId === graphId).at(-1);
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [details, setDetails] = useState<{ key: string; request: Request; value: RunDetailsData } | null>(null);
  const [capacity, setCapacity] = useState<{ request: Request; value: Capacity } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshAnimationKey, setRefreshAnimationKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [continuingKey, setContinuingKey] = useState<string | null>(null);
  const [submittedInteraction, setSubmittedInteraction] = useState<string>();
  const [confirmCancel, setConfirmCancel] = useState<Run | null>(null);
  const [confirmStopChain, setConfirmStopChain] = useState<string | null>(null);
  const [confirmCandidate, setConfirmCandidate] = useState<'accept' | 'discard' | null>(null);
  const actionLock = useRef(false);
  const continuationKeys = useRef(new Map<string, string>());
  const callbacks = useRef({ onError, onChanged });
  callbacks.current = { onError, onChanged };
  const reportedScopeError = useRef('');
  const selectedKey = selected ? JSON.stringify([selected.serviceId, selected.id]) : '';
  const context = useRef({ request, selectedKey });
  context.current = { request, selectedKey };
  const current = details?.key === selectedKey && details.request === request ? details.value : null;
  const candidateUnavailable = Boolean(current?.candidate?.state === 'pending' && !current.target);
  useEffect(() => {
    if (!scopeError) { reportedScopeError.current = ''; return; }
    if (reportedScopeError.current !== scopeError) {
      reportedScopeError.current = scopeError;
      callbacks.current.onError(new Error(scopeError));
    }
  }, [scopeError]);
  useEffect(() => {
    if (candidateUnavailable) callbacks.current.onError(new Error(t('The original node is unavailable, so the candidate cannot be handled.')));
  }, [selectedKey, candidateUnavailable, t]);
  // The parent republishes runs on run/interaction/graph events, including unchanged status.
  useEffect(() => {
    let alive = true;
    if (scopeError || readOnly) return;
    request<Capacity>('/v1/capacity').then(value => { if (alive) setCapacity({ request, value }); }).catch(e => { if (alive) callbacks.current.onError(e); });
    return () => { alive = false; };
  }, [request, runs, revision, readOnly, scopeError]);
  useEffect(() => {
    let alive = true;
    if (mode === 'queue' || !selected || readOnly || scopeError) { setLoading(false); return; }
    setLoading(true);
    readRunDetails(request, selected).then(value => {
      if (alive) {
        setDetails({ key: selectedKey, request, value });
        setError('');
        if (value.errors.length) callbacks.current.onError(new Error(value.errors.join('; ')));
      }
    }).catch(e => {
      if (alive) { setDetails(null); setError(e instanceof Error ? e.message : String(e)); callbacks.current.onError(e); }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [request, selectedKey, runs, revision, readOnly, scopeError, mode]);
  useEffect(() => { setConfirmCandidate(null); }, [current?.target?.contentVersion, current?.candidate?.state]);
  useEffect(() => { setError(''); setConfirmCancel(null); setConfirmStopChain(null); setConfirmCandidate(null); }, [request, selectedKey, readOnly]);
  useEffect(() => {
    if (mode === 'queue' || !selected || readOnly || (isTerminalRunStatus(selected.status) && !error && !current?.errors.length)) return;
    const timer = setInterval(() => setRevision(n => n + 1), 2000);
    return () => clearInterval(timer);
  }, [mode, selectedKey, selected?.status, readOnly, error, current?.errors.length]);
  useEffect(() => { follow.current = true; setPaused(false); }, [selectedKey]);
  useEffect(() => { if (follow.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [current?.history]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (readOnly || scopeError || actionLock.current) return;
    actionLock.current = true; setBusy(true); setError('');
    const sameContext = () => context.current.request === request && context.current.selectedKey === selectedKey;
    try { await action(); if (sameContext()) callbacks.current.onChanged(); }
    catch (e) { if (sameContext()) { setError(e instanceof Error ? e.message : String(e)); callbacks.current.onError(e); } }
    finally {
      actionLock.current = false; setBusy(false);
      if (sameContext()) { setConfirmCancel(null); setConfirmCandidate(null); setRevision(n => n + 1); }
    }
  };
  const disabled = readOnly || busy || loading;
  const continueTask = (run: Run) => {
    if (readOnly || scopeError || actionLock.current) return;
    const key = JSON.stringify([run.serviceId, run.id]);
    const idempotencyKey = continuationKeys.current.get(key) ?? randomId();
    continuationKeys.current.set(key, idempotencyKey);
    setContinuingKey(key);
    void mutate(async () => {
      try { await continueRestoredRun(request, run, idempotencyKey); continuationKeys.current.delete(key); }
      finally { setContinuingKey(null); }
    });
  };
  const queue = ordered.filter(run => !isTerminalRunStatus(run.status));
  const queueHeader = mode === 'queue' && !!props.onClose;
  const refreshControl = <button type="button" className="icon-button run-refresh-button"
    title={t('Refresh')} aria-label={loading ? t('Reading current Workspace records') : t('Refresh')}
    aria-busy={loading} disabled={disabled || !!scopeError}
    onClick={() => { setRefreshAnimationKey(n => n + 1); setError(''); setRevision(n => n + 1); onChanged(); }}>
    <RefreshIcon animationKey={refreshAnimationKey} />
  </button>;
  const stopControl = selected && <>
    {mode === 'details' && ['preparing', 'running', 'waiting_answer', 'waiting_approval', 'reconciling'].includes(selected.status) && (confirmCancel?.id === selected.id ? <div role="group" aria-label={t('Confirm stopping the run')} className="interaction-box"><p>{t('Stop the current run? The Workspace must still confirm the stop after the request is sent. Closing this panel does not stop the task.')}</p><div className="button-row"><button type="button" className="danger-button" disabled={readOnly || busy} onClick={() => void mutate(() => request(pathFor(selected, 'cancel'), { idempotencyKey: randomId() }, 'POST'))}>{t('Confirm stop')}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmCancel(null)}>{t('Continue run')}</button></div></div> : <button type="button" className="danger-button run-detail-stop" disabled={readOnly || busy} onClick={() => setConfirmCancel(selected)}>{t('Stop run')}</button>)}
    {mode === 'details' && selected.status === 'cancelling' && <button type="button" className="danger-button run-detail-stop" disabled>{t('Waiting for cancellation confirmation')}</button>}
  </>;
  return <>
    {queueHeader && <div className="service-panel-heading">
      <h2>{t('Workspace queue')}</h2>
      <div className="run-header-actions">{refreshControl}<button type="button" className="icon-button" title={t('Close Workspace queue')} aria-label={t('Close Workspace queue')} onClick={props.onClose}><X size={16} aria-hidden="true" /></button></div>
    </div>}
    <section className="panel real-runs-panel" aria-label={t('Workspace tasks and run history')} data-canvas-no-zoom style={{ padding: 16, minWidth: 0, overflowWrap: 'anywhere' }}>
    {mode !== 'details' && !queueHeader && <div className="panel-heading run-panel-controls"><strong>{t('Workspace task queue')}</strong>{refreshControl}</div>}
    {scopeError ? <p role="status">{t('The Workspace task scope is invalid. Check the notification and correct it.')}</p> : <>
      {mode !== 'details' && <>
      <p className="muted">{t('Current connected Workspace only · FIFO within the project · Read-only capacity')}{capacity?.request === request ? t(' · {occupied}/{capacity} occupied', { occupied: capacity.value.occupied, capacity: capacity.value.capacity }) : t(' · Capacity pending confirmation')}</p>
      {readOnly && <p role="status">{t('Read-only mode: showing the last known status. Answers, approvals, cancellations, and candidate actions are disabled. Disconnecting the web page does not cancel Workspace tasks.')}</p>}
      <div className="queue-list">
        {!queue.length && <p>{readOnly ? t('No active tasks are cached. Connect to confirm the actual queue.') : t('There are no active tasks.')}</p>}
        {queue.map(run => <article className="queue-row real-queue-item" key={run.id}>
          <button className="queue-locate real-queue-item-main" onClick={() => { setSelectedId(run.id); props.onSelectRun?.(run); onLocate(run); }}>
            <span className="real-queue-item-sequence">{t('Task #{sequence}', { sequence: run.submissionSequence })}</span>
            <strong>{props.describeRun?.(run).node ?? run.nodeId}</strong>
            <span className="real-queue-item-source">{props.describeRun?.(run).project ?? run.projectId} / {props.describeRun?.(run).graph ?? run.graphId}</span>
          </button>
          <div className="real-queue-item-side">
            <span className={'status status-' + run.status}><i aria-hidden="true"/>{t(runStatusMessages[run.status])}</span>
            {run.status === 'paused_restore' && <button type="button" className="primary-button" disabled={readOnly || busy} aria-busy={continuingKey === JSON.stringify([run.serviceId, run.id])} onClick={() => continueTask(run)}>{t(continuingKey === JSON.stringify([run.serviceId, run.id]) ? 'Continuing restored run…' : 'Continue restored run')}</button>}
            <button className="secondary-button real-queue-item-cancel" disabled={readOnly || busy || run.status === 'cancelling'} onClick={() => setConfirmCancel(run)}>{run.status === 'cancelling' ? t('Waiting for cancellation confirmation') : t('Cancel task')}</button>
          </div>
        </article>)}
      </div>
      {confirmCancel && <div role="group" aria-label={t('Confirm task cancellation')} className="interaction-box"><p>{t('Cancel task #{sequence}? The Workspace must still confirm the cancellation after the request is sent. Closing this panel does not cancel the task.', { sequence: confirmCancel.submissionSequence })}</p><div className="button-row"><button className="danger-button" disabled={readOnly || busy} onClick={() => void mutate(() => request(pathFor(confirmCancel, 'cancel'), { idempotencyKey: randomId() }, 'POST'))}>{t('Confirm task cancellation')}</button><button className="secondary-button" disabled={busy} onClick={() => setConfirmCancel(null)}>{t('Keep task')}</button></div></div>}
      </>}
      {mode === 'queue' && ordered.length > 0 && <button className="secondary-button" onClick={() => { const run = selected ?? ordered.at(-1)!; props.onSelectRun?.(run); }}>{t('View run history')}</button>}
      {mode !== 'queue' && <>
      <h3>{t('Run history')}</h3>
      <label>{t('Select run')} <select aria-label={t('Select run')} value={selected?.id ?? ''} onChange={event => { setSelectedId(event.target.value); const run = ordered.find(r => r.id === event.target.value); if (run) props.onSelectRun?.(run); }}><option value="" disabled>{t('Select run')}</option>{[...ordered].reverse().map(run => <option key={run.id} value={run.id}>#{run.submissionSequence} · {t(runStatusMessages[run.status])} · {run.graphId} / {run.nodeId}</option>)}</select></label>
      {busy && <p role="status">{t('Submitting. Waiting for Workspace confirmation…')}</p>}
      {!selected && <p>{t('There are no run records yet.')}</p>}
      {selected && <button className="secondary-button" onClick={() => onLocate(selected)}>{t('Locate this task')}</button>}
      {selected&&!isTerminalRunStatus(selected.status)&&<CliGrantControl key={selectedKey} run={selected} request={request} disabled={readOnly||busy} onError={onError}/>}
      {selected?.status === 'accepted' && selected.executionStart && <ExecutionStartPanel key={selectedKey} run={selected} request={request} inputs={props.executionInputs} disabled={readOnly || busy} onChanged={() => { onChanged(); setRevision(n => n + 1); }} onError={onError} onEditNode={props.onEditExecutionNode ? nodeId=>props.onEditExecutionNode!(selected,nodeId) : undefined} />}
      {selected?.status === 'accepted' && ['manual','confirm'].includes(selected.executionStart ?? '') && <button className="secondary-button" disabled={readOnly || busy} onClick={() => void mutate(() => request(pathFor(selected, 'cancel'), {idempotencyKey:randomId()}, 'POST'))}>{t('Withdraw this submission')}</button>}
      {selected?.status === 'paused_restore' && <div className="interaction-box" role="group" aria-label={t('Paused after restore')}><p>{t('The Workspace will check the saved inputs before continuing this task.')}</p><button type="button" className="primary-button" disabled={readOnly || busy || loading} aria-busy={continuingKey === selectedKey} onClick={() => continueTask(selected)}>{t(continuingKey === selectedKey ? 'Continuing restored run…' : 'Continue restored run')}</button></div>}
      {!current && stopControl}
      {selected && current && <>
        {current.snapshot?.imageRoute?.type==='api' ? <p>{t('Generation method: Image generation API · {provider} / {model} · Configuration v{config} / Credential v{credential}', { provider: current.snapshot.imageRoute.providerId, model: current.snapshot.imageRoute.modelId, config: current.snapshot.imageRoute.configRevision, credential: current.snapshot.imageRoute.credentialRevision })}</p> : current.snapshot?.imageRoute?.type==='codex' ? <p>{t('Generation method: Codex image generation')}</p> : null}
        {current.publicMetadata?.requestId && <p>{t('Provider request ID: {id}', { id: current.publicMetadata.requestId })}</p>}
        {!!current.errors.length && <p role="status">{t('Some details could not be read. Available content remains visible and will be retried automatically.')}</p>}
        {current.changes?.state !== 'unchanged' && <p className="input-changed">{!current.changes ? t('Input changes could not be read, so changes cannot be determined.') : current.changes.state === 'changed' ? t('The input has changed. This run still uses the frozen input.') : t('Input changes are unknown because the current input has issues.')}</p>}
        {!!current.changes?.issues.length && <JsonBlock value={current.changes.issues} />}
        <details className="run-section" open><RunSectionSummary>{t('Run progress')}</RunSectionSummary>{!current.history ? <p>{t('History could not be read. It will be retried automatically.')}</p> : current.history.historyState === 'cleared' ? <p>{t('Detailed progress was cleared. Run and delivery records remain available.')}</p> : current.history.records.length ? <div className="run-detail-log-wrap">
          <RunProcessList className="detail-log" ariaLabel={t('Run progress list')} status={selected.status} items={runProgressEntries(current.history).map(entry => entry.text)} collapseLongItems ref={logRef} onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28; setPaused(!follow.current); }}>
            <RunInteractionRecords interactions={current.interactions} active={current.active} disabled={readOnly || busy || !!current.errors.length || !['waiting_answer', 'waiting_approval'].includes(selected.status)} onReply={answer => void mutate(async () => { await replyToInteraction(request, selected, current.active!, answer, randomId()); setSubmittedInteraction(current.active!.id); })} submittedId={submittedInteraction} onError={onError}/>
          </RunProcessList>
          {paused && <button className="run-detail-jump" type="button" aria-label={t('Jump to latest record')} title={t('Jump to latest record')} onClick={() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}><ArrowDown size={18} aria-hidden="true" /></button>}
        </div> : <p>{t('The Workspace has no progress records yet.')}</p>}
          {(!current.history || current.history.historyState === 'cleared' || !current.history.records.length) && <RunInteractionRecords interactions={current.interactions} active={current.active} disabled={readOnly || busy || !!current.errors.length || !['waiting_answer', 'waiting_approval'].includes(selected.status)} onReply={answer => void mutate(async () => { await replyToInteraction(request, selected, current.active!, answer, randomId()); setSubmittedInteraction(current.active!.id); })} submittedId={submittedInteraction} onError={onError}/>}
          {stopControl}
          {selected.chainControl === 'active' && (confirmStopChain === selectedKey ? <div role="group" aria-label={t('Confirm stopping the entire schedule')} className="interaction-box run-detail-chain-control"><p>{t('Stop all unfinished tasks in this chain? Waiting nodes are cancelled immediately, running nodes wait for stop confirmation, and completed outputs are kept.')}</p><div className="button-row"><button className="danger-button" disabled={readOnly || busy} onClick={() => void mutate(async () => { await request(pathFor(selected, 'cancel-chain'), {idempotencyKey:randomId()}, 'POST'); setConfirmStopChain(null); })}>{t('Confirm stop entire schedule')}</button><button className="secondary-button" disabled={busy} onClick={() => setConfirmStopChain(null)}>{t('Continue execution')}</button></div></div> : <button className="danger-button run-detail-chain-control" disabled={readOnly} onClick={() => setConfirmStopChain(selectedKey)}>{t('Stop entire schedule')}</button>)}
          {selected.chainControl === 'stopping' && <p className="run-detail-chain-control" role="status">{t('The entire schedule has stopped and is waiting for running nodes to confirm stopping…')}</p>}
          {selected.chainControl === 'stopped' && <p className="run-detail-chain-control" role="status">{t('This chain has stopped.')}</p>}
        </details>
        {current.candidate?.state === 'pending' && <section key={selectedKey} className="interaction-box" aria-label={t('Generated candidate')}><strong>{t('Generated candidate · {state}', { state: current.candidate.state })}</strong><p>{t('Generation baseline version {version}; the candidate did not automatically replace the current body.', { version: current.candidate.baseVersion })}</p><CollapsibleRunValue value={current.candidate.content} />
          {current.target ? <><p>{t('Current body version {version}', { version: current.target.contentVersion })}</p><CollapsibleRunValue value={current.target.content} /></> : <p role="status">{t('The current candidate cannot be handled yet. Check the notification.')}</p>}
          <div className="button-row"><button className="primary-button" disabled={disabled || !current.target || current.target.readOnly} onClick={() => setConfirmCandidate('accept')}>{t('Accept candidate')}</button><button className="secondary-button" disabled={disabled || !current.target || current.target.readOnly} onClick={() => setConfirmCandidate('discard')}>{t('Discard candidate')}</button></div>
          {confirmCandidate && current.target && <div role="group" aria-label={t('Confirm candidate action')}><p>{t('{action}, validating version {version}.', { action: confirmCandidate === 'accept' ? t('Replace the current body above with the candidate') : t('Discard this candidate and keep the current body'), version: current.target.contentVersion })}</p><button className="primary-button" disabled={disabled} onClick={() => void mutate(() => decideRunCandidate(request, selected, confirmCandidate, current.target!.contentVersion, randomId()))}>{confirmCandidate === 'accept' ? t('Confirm accept') : t('Confirm discard')}</button><button className="secondary-button" disabled={busy} onClick={() => setConfirmCandidate(null)}>{t('Back')}</button></div>}
        </section>}
        <details className="snapshot-details run-section"><RunSectionSummary>{t('Parameters for this run')}</RunSectionSummary><RunParameters snapshot={current.snapshot} run={selected} nodes={props.graphs?.find(graph => graph.serviceId === selected.serviceId && graph.projectId === selected.projectId && graph.graphId === selected.graphId)?.nodes ?? []} /></details>
      </>}
      </>}
    </>}
  </section></>;
}
