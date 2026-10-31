import { ChevronRight } from 'lucide-react';
import type { RunStatus } from '../../../packages/protocol/src/index';
import type { RunTodo } from './notifications';
import { NotificationQueue, type NotificationItem, type NotificationKind } from './NotificationCenter';
import '../i18n/catalogs/runs';
import { useI18n } from '../i18n/I18nProvider';

const runStatusMessages: Record<RunStatus, string> = {
  accepted: 'Waiting to start', queued: 'Queued', preparing: 'Preparing', running: 'Running',
  waiting_answer: 'Waiting for answer', waiting_approval: 'Waiting for approval', agent_completed: 'Agent completed',
  finalizing: 'Publishing', cancelling: 'Confirming cancellation', reconciling: 'Checking status',
  paused_restore: 'Paused after restore', succeeded: 'Succeeded', failed: 'Failed',
  cancelled: 'Cancelled', interrupted: 'Interrupted',
};
function runKind(status: RunStatus): NotificationKind {
  if (status === 'waiting_answer' || status === 'waiting_approval') return 'action';
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'error';
  return 'warning';
}
export function RunNotifications({ todos, onOpen, onDismiss }: {
  todos: RunTodo[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { language, t } = useI18n();
  const items: NotificationItem[] = todos.map(todo => {
    const status = t(runStatusMessages[todo.status]);
    return { id: todo.id, kind: runKind(todo.status), duration: null, dismissLabel: t('Mark as read'),
      content: <button className="workgraph-notification-open" type="button" aria-label={t('View {status} run details', { status })} onClick={() => onOpen(todo.id)}>
        <span className="workgraph-notification-status"><strong>{status}</strong><ChevronRight size={14} aria-hidden="true"/></span>
        <span className="workgraph-notification-source">{todo.serviceName}</span>
        <time dateTime={todo.createdAt}>{new Date(todo.createdAt).toLocaleString(language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time>
      </button>,
    };
  });
  return <NotificationQueue items={items} onDismiss={onDismiss}/>;
}
