import { RUN_STATUSES, type RunNotification, type RunStatus } from '../../../packages/protocol/src/index';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

const runStatusMessages: Record<RunStatus, string> = {
  accepted: 'Waiting to start', queued: 'Queued', preparing: 'Preparing', running: 'Running',
  waiting_answer: 'Waiting for answer', waiting_approval: 'Waiting for approval', agent_completed: 'Agent completed',
  finalizing: 'Publishing', cancelling: 'Confirming cancellation', reconciling: 'Verifying status',
  paused_restore: 'Paused after restore', succeeded: 'Completed', failed: 'Failed',
  cancelled: 'Cancelled', interrupted: 'Interrupted',
};
export const runStatusLabels = new Proxy(runStatusMessages, {
  get: (messages, status: RunStatus) => translate(messages[status]),
}) as Record<RunStatus, string>;
export interface RunTodo {
  id: string; serviceId: string; serviceName: string; runId: string; notificationRevision: number;
  projectId: string; graphId: string; nodeId: string; status: RunStatus; createdAt: string;
}
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export interface RunNotificationOptions {
  storage?: StoragePort;
  revalidateSession: (serviceId: string) => Promise<boolean>;
  markRead: (todo: RunTodo) => Promise<void>;
  markAllRead: (serviceId: string) => Promise<void>;
  onOpen: (todo: RunTodo) => void | Promise<void>;
  onError?: (error: unknown) => void;
}
const STORAGE_KEY = 'openworkgraph.run-notifications.v1';
const attention = new Set<RunStatus>(['succeeded', 'failed', 'waiting_answer', 'waiting_approval', 'interrupted']);
const identity = (serviceId: string, runId: string) => JSON.stringify([serviceId, runId]);

/** Runtime owns notification/read state. Browser storage contains only desktop opt-in. */
export function createRunNotifications(options: RunNotificationOptions) {
  const listeners = new Set<() => void>();
  const enabledServices = new Set<string>();
  const serviceGeneration = new Map<string, number>();
  const desktop = new Map<string, Notification>();
  const seenRevision = new Map<string, number>();
  let desktopEnabled = false;
  let desktopGeneration = 0;
  let todos: RunTodo[] = [];
  let storage = options.storage;
  const report = (error: unknown) => options.onError?.(error);
  try {
    storage ??= typeof localStorage === 'undefined' ? undefined : localStorage;
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      desktopEnabled = data?.desktopOptIn === true && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    }
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 3, desktopOptIn: desktopEnabled }));
  } catch (error) { report(error); }
  const persistPreference = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 3, desktopOptIn: desktopEnabled })); }
    catch (error) { report(error); }
    listeners.forEach(listener => listener());
  };
  const changed = () => listeners.forEach(listener => listener());
  const close = (id: string) => { desktop.get(id)?.close(); desktop.delete(id); };
  const dismiss = async (id: string): Promise<boolean> => {
    const todo = todos.find(item => item.id === id);
    if (!todo) return false;
    await options.markRead({ ...todo });
    if (todos.find(item => item.id === id)?.notificationRevision === todo.notificationRevision) {
      todos = todos.filter(item => item.id !== id);
      close(id);
      changed();
    }
    return true;
  };
  const suspendService = (serviceId: string) => {
    enabledServices.delete(serviceId);
    serviceGeneration.set(serviceId, (serviceGeneration.get(serviceId) ?? 0) + 1);
    todos.filter(todo => todo.serviceId === serviceId).forEach(todo => close(todo.id));
  };
  const removeService = (serviceId: string) => {
    suspendService(serviceId);
    todos = todos.filter(todo => todo.serviceId !== serviceId);
    changed();
  };
  const open = async (id: string): Promise<boolean> => {
    const todo = todos.find(item => item.id === id);
    if (!todo) return false;
    const generation = serviceGeneration.get(todo.serviceId) ?? 0;
    try {
      const valid = await options.revalidateSession(todo.serviceId);
      if (generation !== (serviceGeneration.get(todo.serviceId) ?? 0)) return false;
      if (!valid) { suspendService(todo.serviceId); return false; }
      const latest = todos.find(item => item.id === id);
      if (!latest) return false;
      await options.onOpen({ ...latest });
      if (todos.find(item => item.id === id)?.notificationRevision === latest.notificationRevision) await dismiss(id);
      return true;
    } catch (error) { report(error); return false; }
  };
  return {
    list: (): RunTodo[] => todos.map(todo => ({ ...todo })),
    isDesktopEnabled: () => desktopEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted',
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dismiss, suspendService, removeService, open,
    async dismissAll(): Promise<void> {
      const services = [...new Set(todos.map(todo => todo.serviceId))];
      await Promise.all(services.map(serviceId => options.markAllRead(serviceId)));
      todos.forEach(todo => close(todo.id));
      todos = [];
      changed();
    },
    ingest(service: { serviceId: string; name: string }, notifications: RunNotification[]) {
      if (notifications.some(notification => notification.run.serviceId !== service.serviceId)) throw new Error(translate("The notification snapshot contains tasks from another Workspace."));
      enabledServices.add(service.serviceId);
      const present = new Set(notifications.map(notification => identity(service.serviceId, notification.run.id)));
      todos.filter(todo => todo.serviceId === service.serviceId && !present.has(todo.id)).forEach(todo => close(todo.id));
      todos = todos.filter(todo => todo.serviceId !== service.serviceId || present.has(todo.id));
      for (const notification of notifications) {
        const run = notification.run;
        if (!attention.has(run.status) || !Number.isSafeInteger(notification.revision) || notification.revision < 1 || !RUN_STATUSES.includes(run.status)) continue;
        const id = identity(service.serviceId, run.id);
        const isNew = seenRevision.get(id) !== notification.revision;
        seenRevision.set(id, notification.revision);
        const todo: RunTodo = { id, serviceId: service.serviceId, serviceName: service.name, runId: run.id, notificationRevision: notification.revision, projectId: run.projectId, graphId: run.graphId, nodeId: run.nodeId, status: run.status, createdAt: notification.createdAt };
        todos = [...todos.filter(item => item.id !== id), todo];
        if (isNew && desktopEnabled && enabledServices.has(service.serviceId) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            close(id);
            const desktopNotification = new Notification(service.name, { body: runStatusLabels[run.status] });
            desktopNotification.onclick = () => {
              desktopNotification.close();
              try { if (typeof window !== 'undefined') window.focus(); } catch { /* browser policy */ }
              void open(id);
            };
            desktop.set(id, desktopNotification);
          } catch (error) { report(error); }
        }
      }
      changed();
    },
    async enableDesktop(): Promise<NotificationPermission | 'unsupported'> {
      if (typeof Notification === 'undefined') return 'unsupported';
      const generation = ++desktopGeneration;
      try {
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (generation === desktopGeneration) { desktopEnabled = permission === 'granted'; persistPreference(); }
        return permission;
      } catch (error) { report(error); return 'denied'; }
    },
    disableDesktop() { desktopGeneration++; desktopEnabled = false; [...desktop.keys()].forEach(close); persistPreference(); },
  };
}
