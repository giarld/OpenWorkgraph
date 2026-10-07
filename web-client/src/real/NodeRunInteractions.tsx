import { useEffect, useRef, useState } from 'react';
import { type Interaction, type Json, type Run } from '../../../packages/protocol/src/index';
import { randomId } from '../adapter/random';
import { useI18n } from '../i18n/I18nProvider';
import { RunInteractionRecords, replyToInteraction, visibleRunInteractions, type RunsPanelProps } from './RunsPanel';

/** Node progress shares the detail form and the Workspace's ordered reply contract. */
export function NodeRunInteractions({ run, request, disabled, onChanged, onError }: {
  run: Run; request: RunsPanelProps['request']; disabled: boolean;
  onChanged: () => void; onError: (error: unknown) => void;
}) {
  const { t, language } = useI18n();
  const [records, setRecords] = useState<{ request: typeof request; interactions: Interaction[]; active: Interaction | null; omitted: boolean }>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submittedId, setSubmittedId] = useState<string>();
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const lock = useRef(false);
  const callbacks = useRef({ onChanged, onError });
  callbacks.current = { onChanged, onError };
  const context = useRef({ request, disabled });
  context.current = { request, disabled };
  useEffect(() => {
    if (disabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const base = '/v1/runs/' + encodeURIComponent(run.id);
        const [interactions, active] = await Promise.all([
          request<Interaction[]>(base + '/interactions'), request<Interaction | null>(base + '/active-interaction'),
        ]);
        if (interactions.some(item => item.runId !== run.id) || active && active.runId !== run.id) throw new Error(t('The interaction does not match the current run.'));
        const visible = visibleRunInteractions(interactions);
        if (live) { setRecords({ request, interactions: visible.slice(-10), active, omitted: visible.length > 10 }); setReadError(''); }
      } catch (e) { if (live) setReadError(e instanceof Error ? e.message : String(e)); }
      if (live && ['waiting_answer', 'waiting_approval'].includes(run.status)) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [request, run.id, run.status, disabled, revision, language]);
  const current = records?.request === request ? records : undefined;
  const reply = async (answer: Json) => {
    if (disabled || lock.current || !current?.active || submittedId === current.active.id) return;
    const active = current.active;
    lock.current = true; setBusy(true); setError('');
    try {
      await replyToInteraction(request, run, active, answer, randomId());
      if (context.current.request === request) {
        setSubmittedId(active.id); callbacks.current.onChanged();
      }
    } catch (e) {
      if (context.current.request === request) { setError(e instanceof Error ? e.message : String(e)); callbacks.current.onError(e); }
    } finally { lock.current = false; setBusy(false); setRevision(value => value + 1); }
  };
  return <>
    {readError && <p role="status">{readError}</p>}
    {error && <p role="status">{error}</p>}
    {current?.omitted && <p className="muted">{t('Earlier progress or full messages are available in run details.')}</p>}
    {!current && ['waiting_answer', 'waiting_approval'].includes(run.status) && <p role="status">{t('Reading current Workspace records')}</p>}
    {current && <RunInteractionRecords interactions={current.interactions} active={current.active} submittedId={submittedId}
      disabled={disabled || busy || !!readError || !['waiting_answer', 'waiting_approval'].includes(run.status)} onReply={answer => void reply(answer)} onError={onError}/>}
  </>;
}
