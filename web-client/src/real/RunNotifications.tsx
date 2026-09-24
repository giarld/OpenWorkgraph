import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, CheckCheck, CheckCircle2, ChevronRight, CircleAlert } from 'lucide-react';
import type { RunStatus } from '../../../packages/protocol/src/index';
import type { RunTodo } from './notifications';
import '../i18n/catalogs/runs';
import { useI18n } from '../i18n/I18nProvider';

type Notice = RunTodo;
const runStatusMessages: Record<RunStatus, string> = {
  accepted: 'Waiting to start', queued: 'Queued', preparing: 'Preparing', running: 'Running',
  waiting_answer: 'Waiting for answer', waiting_approval: 'Waiting for approval', agent_completed: 'Agent completed',
  finalizing: 'Publishing', cancelling: 'Confirming cancellation', reconciling: 'Checking status',
  paused_restore: 'Paused after restore', succeeded: 'Succeeded', failed: 'Failed',
  cancelled: 'Cancelled', interrupted: 'Interrupted',
};

export function RunNotifications({ todos, onOpen, onDismiss, onDismissAll }: {
  todos: Notice[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  const { t } = useI18n();
  const stamp = JSON.stringify(todos);
  const [retained, setRetained] = useState({ stamp, items: todos });
  if (retained.stamp !== stamp) {
    setRetained({ stamp, items: [
      ...retained.items.map(todo => todos.find(item => item.id === todo.id) ?? todo),
      ...todos.filter(todo => !retained.items.some(item => item.id === todo.id)),
    ] });
  }
  const remove = useCallback((id: string) => {
    setRetained(value => ({ ...value, items: value.items.filter(todo => todo.id !== id) }));
  }, []);
  if (!retained.items.length) return null;
  return <section className="workgraph-notifications" aria-label={t('Pending actions and result notifications')}>
    <header><Bell size={14} aria-hidden="true" /><h2>{t('Pending actions and result notifications')}</h2><span>{todos.length}</span></header>
    <ul>{retained.items.map(saved => {
      const current = todos.find(todo => todo.id === saved.id);
      return <RunNotification key={saved.id} todo={current ?? saved} exiting={!current}
        onExited={remove} onOpen={onOpen} onDismiss={onDismiss} />;
    })}</ul>
    <footer><button className="workgraph-notifications-clear" type="button" onClick={onDismissAll} disabled={!todos.length} title={t('Mark all notifications as read')}><CheckCheck size={16} aria-hidden="true" />{t('Clear all')}</button></footer>
  </section>;
}

function RunNotification({ todo, exiting, onExited, onOpen, onDismiss }: {
  todo: Notice; exiting: boolean; onExited: (id: string) => void;
  onOpen: (id: string) => void; onDismiss: (id: string) => void;
}) {
  const { language, t } = useI18n();
  const status = t(runStatusMessages[todo.status]);
  useEffect(() => {
    if (!exiting) return;
    // Fallback for disabled animations or background tabs.
    const timer = setTimeout(() => onExited(todo.id), 240);
    return () => clearTimeout(timer);
  }, [exiting, onExited, todo.id]);
  return <li className="workgraph-notification" data-phase={exiting ? 'exit' : 'enter'} inert={exiting}
    onAnimationEnd={event => {
      if (exiting && event.target === event.currentTarget) onExited(todo.id);
    }}>
    <button className="workgraph-notification-open" type="button" aria-label={t('View {status} run details', { status })} onClick={() => onOpen(todo.id)}>
      <span className="workgraph-notification-status">{todo.status === 'succeeded' ? <CheckCircle2 size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}<strong>{status}</strong><ChevronRight size={14} aria-hidden="true" /></span>
      <span className="workgraph-notification-source">{todo.serviceName}</span>
      <time dateTime={todo.createdAt}>{new Date(todo.createdAt).toLocaleString(language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time>
    </button>
    <button className="workgraph-notification-dismiss" type="button" aria-label={t('Mark as read')} title={t('Mark as read')} onClick={() => onDismiss(todo.id)}><Check size={16} aria-hidden="true" /></button>
  </li>;
}
