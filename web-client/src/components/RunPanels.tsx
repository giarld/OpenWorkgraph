import type { SkillCandidate as ProtocolSkillCandidate, SkillReference } from "../../../packages/protocol/src/skills";
import { legacySkillMentions } from "../../../packages/protocol/src/skills";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Folder,
  History,
  ListTodo,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type {
  AdapterSnapshot,
  Run,
  RunStatus,
  WorkNode,
  WorkgraphAdapter,
} from "../domain/types";
import { isTerminal } from "../domain/types";
import { canDropProjectFile, takeProjectFileDrag } from "../real/project-file-drag";
import { insertReferenceMention, type ReferenceMentionCandidate } from "../real/reference-mentions";
import { PromptTextInput, type PromptTextInputHandle } from "./PromptTextInput";
import {
  findMentionQuery,
  insertProjectFileMarkdownLink,
  insertSkillReference,
  syncSkillReferences,
  orderedSkillCandidates,
  type ProjectFileMentionCandidate,
} from "../real/project-file-mentions";
import { useI18n } from "../i18n/I18nProvider";
export const statusLabels: Record<RunStatus, string> = {
  queued: "Queued",
  preparing: "Preparing",
  running: "Running",
  waiting_input: "Awaiting answer",
  waiting_approval: "Awaiting approval",
  finalizing: "Publishing",
  cancelling: "Stopping",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};
export function Status({ run }: { run: Run }) {
  const { t } = useI18n();
  return (
    <span className={`status status-${run.status}`}>
      <i />
      {t(statusLabels[run.status])}
      {run.cancelRequested &&
      run.status !== "cancelling" &&
      !isTerminal(run.status)
        ? t(" · Cancellation pending confirmation")
        : ""}
    </span>
  );
}
type BaseProps = { adapter: WorkgraphAdapter; onError(error: unknown): void };
export function PromptPanel({
  node,
  adapter,
  run,
  onClose,
  onOpen,
  onRun,
  onError,
}: BaseProps & {
  node: WorkNode;
  run?: Run;
  onClose(): void;
  onOpen(nodeId: string): void;
  onRun(): void;
}) {
  const { t } = useI18n();
  const refs = adapter.getReferences(node.graphId, node.id);
  const locked = adapter.isNodeLocked(node.graphId, node.id);
  const connected = adapter
    .getSnapshot()
    .services.some(
      (service) => service.id === node.serviceId && service.connected,
    );
  const busy = !!run && !isTerminal(run.status);
  return <PromptEditor key={node.id}
    ariaLabel={t("Execution prompt")} value={node.prompt} disabled={locked || !connected}
    runDisabled={locked || busy || !connected || !node.prompt.trim()}
    references={refs.map(ref => ({ id: ref.nodeId, title: ref.title }))}
    onOpenReference={onOpen} onClose={onClose} onRun={onRun}
    onChange={prompt => { try { adapter.updateNode(node.graphId, node.id, { prompt }); } catch (error) { onError(error); } }}
    inputChanged={!!run && adapter.hasInputChanges(run.id)}
    placeholder={node.type === "execution" ? t("Describe the work you want to complete…") : t("Describe how you want to revise this text")}
    status={locked ? t("Locked while running") : t("Development simulation · Ctrl ↵ to run")}
    runLabel={node.type === "execution" ? t("Run") : t("Generate")}
  />;
}
type MentionRequest = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
type SkillCandidate = ProtocolSkillCandidate & { kind: "skill" };
type MentionCandidate = ProjectFileMentionCandidate | SkillCandidate | ReferenceMentionCandidate;
const mentionGroup = (item: MentionCandidate) => item.kind === "directory" ? "file" : item.kind === "skill" ? item.source : item.kind;
type MentionState = {
  start: number;
  query: string;
  items: MentionCandidate[];
  active: number;
  loading: boolean;
};
const MENTION_SEARCH_RESULT = 20;
const MENTION_DEBOUNCE_MS = 120;
/** Shared phase-one editing surface. Storage and execution stay in the caller. */
export function PromptEditor({ value, disabled, runDisabled, references, onOpenReference, onClose, onRun, onChange,
  ariaLabel, placeholder, status, runHint, runLabel, controls, inputChanged, submitting = false, additionalWarnings = [], children,
  mentionRequest, mentionProjectId, mentionEnabled = false, skillEnabled = false, skillReferences = [], onOpenProjectFile }: {
  value: string; disabled: boolean; runDisabled: boolean; submitting?: boolean;
  references: { id: string; title: string }[];
  onOpenReference(id: string): void; onClose(): void; onRun(): void; onChange(value: string, skillReferences?: SkillReference[]): void;
  skillReferences?: SkillReference[];
  ariaLabel?: string; placeholder?: string; status?: string; runHint?: string; runLabel?: string; controls?: ReactNode; inputChanged?: boolean; children?: ReactNode;
  additionalWarnings?: string[];
  mentionRequest?: MentionRequest; mentionProjectId?: string; mentionEnabled?: boolean; skillEnabled?: boolean; onOpenProjectFile?: (item: ProjectFileMentionCandidate) => void;
}) {
  const { t } = useI18n();
  const resolvedAriaLabel = ariaLabel ?? t("Prompt");
  const resolvedRunLabel = runLabel ?? t("Run");
  const visibleStatus = status && !status.startsWith(t("In progress")) ? status : "";
  const inputRef = useRef<PromptTextInputHandle>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const mentionEpoch = useRef(0);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingCaret = useRef<number | undefined>(undefined);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionTop, setMentionTop] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<ProtocolSkillCandidate[] | null>(null);
  const [skillRefresh, setSkillRefresh] = useState(0);
  const referenceIdentities = JSON.stringify(skillReferences.map(ref => [ref.source, ref.skillId]));
  const hasLegacySkills = legacySkillMentions(value).length > 0;
  useEffect(() => {
    let cancelled = false;
    setAvailableSkills(null);
    if (skillEnabled && mentionEnabled && mentionRequest && mentionProjectId && (skillReferences.length || hasLegacySkills)) {
      void mentionRequest<{ items: ProtocolSkillCandidate[] }>("/v1/projects/" + encodeURIComponent(mentionProjectId) + "/skills").then(result => {
        if (!cancelled) setAvailableSkills(result.items);
      }).catch(() => { /* An unavailable catalog is not evidence of a missing skill. */ });
    }
    return () => { cancelled = true; };
  }, [mentionRequest, mentionProjectId, mentionEnabled, skillEnabled, referenceIdentities, hasLegacySkills, skillRefresh]);
  const missingSkills = skillReferences.filter(ref => (ref.source === "codex" && ref.skillId.startsWith("codex-unresolved:")) || (availableSkills && !availableSkills.some(item => item.source === ref.source && item.skillId === ref.skillId)));
  const notices = [
    ...additionalWarnings.map(text => ({ text, warning: true })),
    ...(missingSkills.length ? [{ text: t("Referenced skills are missing from this Workspace. Install them or select them again:") + " " + Array.from(new Set(missingSkills.map(ref => ref.name + " (" + (ref.source === "openworkgraph" ? "OpenWorkgraph" : "Codex") + ")"))).join(", "), warning: true }] : []),
    { text: visibleStatus, warning: false },
    { text: runHint && !runHint.startsWith(t("In progress")) ? runHint : "", warning: false },
    { text: inputChanged ? t("Input updated · The next run will use the new content") : "", warning: true },
  ].filter((notice, index, all) => notice.text && all.findIndex(item => item.text === notice.text) === index);
  const updateMentionPosition = () => {
    if (inputRef.current) setMentionTop(inputRef.current.caretTop() - 6);
  };
  useLayoutEffect(() => {
    if (!mention || !inputRef.current) return;
    updateMentionPosition();
    const observer = new ResizeObserver(updateMentionPosition);
    observer.observe(inputRef.current.element!);
    return () => observer.disconnect();
  }, [mention, value]);
  useLayoutEffect(() => {
    const menu = mentionMenuRef.current;
    if (!menu || !mention?.items.length) return;
    if (mention.active === 0) { menu.scrollTop = 0; return; }
    const option = menu.querySelectorAll<HTMLElement>('[role="option"]')[mention.active];
    if (!option) return;
    const menuRect = menu.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    const top = menuRect.top + menu.clientTop;
    const bottom = top + menu.clientHeight;
    if (optionRect.top < top) menu.scrollTop -= top - optionRect.top;
    else if (optionRect.bottom > bottom) menu.scrollTop += optionRect.bottom - bottom;
  }, [mention?.active, mention?.items]);
  useLayoutEffect(() => {
    if (pendingCaret.current !== undefined && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = undefined;
    }
  }, [value]);
  useEffect(() => () => clearTimeout(mentionTimer.current), []);
  const dismissMention = () => {
    clearTimeout(mentionTimer.current);
    mentionEpoch.current++;
    setMention(null);
  };
  const referenceCandidates = (query: string): ReferenceMentionCandidate[] => references
    .filter(ref => ref.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .map(ref => ({ id: ref.id, name: ref.title, kind: "reference" }));
  const runMentionSearch = (start: number, query: string) => {
    const epoch = ++mentionEpoch.current;
    const trimmed = query.trim();
    const base = "/v1/projects/" + encodeURIComponent(mentionProjectId ?? "");
    const referencesFound = referenceCandidates(query);
    const remoteEnabled = mentionEnabled && !!mentionRequest && !!mentionProjectId;
    const files = remoteEnabled && trimmed ? mentionRequest!<{ items: ProjectFileMentionCandidate[] }>(base + "/files/search?" + new URLSearchParams({ query: trimmed, showHidden: "false", limit: String(MENTION_SEARCH_RESULT) })) : Promise.resolve({ items: [] });
    const skills = remoteEnabled && skillEnabled ? mentionRequest!<{ items: ProtocolSkillCandidate[] }>(base + "/skills/search?" + new URLSearchParams({ query: trimmed })) : Promise.resolve({ items: [] });
    void Promise.allSettled([files, skills]).then(results => {
      if (epoch !== mentionEpoch.current) return;
      const fileItems = results[0].status === "fulfilled" ? (results[0].value.items ?? []).filter(item => item.kind === "file" || item.kind === "directory") : [];
      const skillItems: SkillCandidate[] = results[1].status === "fulfilled" ? orderedSkillCandidates(results[1].value.items ?? []).map(item => ({ ...item, kind: "skill" })) : [];
      const items = [...referencesFound, ...fileItems, ...skillItems];
      setMention(current => current && current.start === start ? { ...current, items, active: Math.max(0, Math.min(current.active, items.length - 1)), loading: false } : current);
    });
  };
  const updateMention = (text: string, cursor: number) => {
    clearTimeout(mentionTimer.current);
    mentionEpoch.current++;
    const found = findMentionQuery(text, cursor);
    if (disabled || !found || (!references.length && !(mentionEnabled && mentionProjectId && mentionRequest))) {
      setMention(null);
      return;
    }
    setMention({ start: found.start, query: found.query, items: referenceCandidates(found.query), active: 0, loading: true });
    mentionTimer.current = setTimeout(() => runMentionSearch(found.start, found.query), MENTION_DEBOUNCE_MS);
  };
  useLayoutEffect(() => { dismissMention(); }, [mentionRequest, mentionProjectId, mentionEnabled, skillEnabled]);
  useEffect(() => {
    const refresh = () => {
      setSkillRefresh(current => current + 1);
      const input = inputRef.current;
      if (input && document.activeElement === input.element) updateMention(input.value, input.selectionStart);
    };
    window.addEventListener("openworkgraph:skills-changed", refresh);
    return () => window.removeEventListener("openworkgraph:skills-changed", refresh);
  }, [mentionRequest, mentionProjectId, mentionEnabled, skillEnabled, references]);
  const insertMention = (item: MentionCandidate) => {
    const input = inputRef.current;
    if (!input || !mention) return;
    const text = input.value;
    const cursor = input.selectionStart ?? text.length;
    const next = item.kind === "reference" ? insertReferenceMention(text, mention.start, cursor, item) : item.kind === "skill" ? insertSkillReference(text, mention.start, cursor, item, skillReferences) : insertProjectFileMarkdownLink(text, mention.start, cursor, item);
    pendingCaret.current = next.caret;
    dismissMention();
    onChange(next.value, "skillReferences" in next ? next.skillReferences as SkillReference[] : syncSkillReferences(text, next.value, skillReferences, { start: mention.start, end: cursor, text: next.value.slice(mention.start, next.caret) }));
  };
  const recheckMention = () => {
    const input = inputRef.current;
    if (!input || !mention) return;
    const cursor = input.selectionStart ?? input.value.length;
    const found = findMentionQuery(input.value, cursor);
    if (!found || found.start !== mention.start) dismissMention();
    else updateMentionPosition();
  };
  const triggerMention = () => {
    const input = inputRef.current;
    if (!input || disabled || composing.current) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const prefix = start > 0 && !/\s/.test(input.value[start - 1]) ? " " : "";
    input.focus();
    input.setSelectionRange(start, end);
    input.insertText(prefix + "@");
  };
  return <section className="prompt-panel panel" aria-label={t("Prompt editor")}>
    <div className="reference-area">
      <div className="prompt-reference-heading"><span className="muted">{t("Reference content")}</span><button className="icon-button" aria-label={t("Close prompt")} onClick={onClose}><X size={14}/></button></div>
      <div className="reference-list">{references.length ? references.map(ref => <button key={ref.id} className="reference-chip" title={t("View directly referenced content")} onClick={() => onOpenReference(ref.id)}><FileText size={14}/><span className="reference-chip-label" title={ref.title}>{ref.title}</span></button>) : <p className="muted">{t("No reference content")}</p>}</div>
    </div>
    <div className="prompt-input">
      <PromptTextInput ref={inputRef} label={resolvedAriaLabel} placeholder={placeholder} value={value} disabled={disabled} skillEnabled={skillEnabled} skillReferences={skillReferences} skillNames={availableSkills?.map(item => item.name)} onOpenFile={onOpenProjectFile} onOpenReference={onOpenReference}
        onScroll={() => { if (mention) updateMentionPosition(); }}
        onDragOver={event => {
          if (disabled || !mentionEnabled || !mentionProjectId || !canDropProjectFile(event.dataTransfer, mentionProjectId)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={event => {
          if (disabled || !mentionEnabled || !mentionProjectId || !canDropProjectFile(event.dataTransfer, mentionProjectId)) return;
          event.preventDefault();
          event.stopPropagation();
          const relativePath = takeProjectFileDrag(event.dataTransfer, mentionProjectId);
          if (!relativePath) return;
          const input = inputRef.current!;
          const start = input.selectionStart;
          const end = input.selectionEnd;
          const next = insertProjectFileMarkdownLink(input.value, start, end, { name: relativePath.split('/').pop()!, relativePath, kind: 'file' });
          pendingCaret.current = next.caret;
          dismissMention();
          input.focus();
          onChange(next.value, syncSkillReferences(input.value, next.value, skillReferences, { start, end, text: next.value.slice(start, next.caret) }));
        }}
        onCompositionStart={() => { composing.current = true; dismissMention(); }}
        onCompositionEnd={(text, cursor) => {
          composing.current = false;
          updateMention(text, cursor);
        }}
        onChange={(text, cursor, refs) => {
          onChange(text, refs);
          if (composing.current) { dismissMention(); return; }
          updateMention(text, cursor);
        }}
        onSelect={recheckMention}
        onBlur={() => { clearTimeout(mentionTimer.current); mentionEpoch.current++; setMention(null); }}
        onKeyDown={e => {
          const duringComposition = composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
          if (mention) {
            if (!duringComposition && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              if (!mention.items.length) return;
              const next = e.key === "ArrowDown"
                ? (mention.active + 1) % mention.items.length
                : (mention.active - 1 + mention.items.length) % mention.items.length;
              setMention({ ...mention, active: next });
              return;
            }
            if (!duringComposition && (e.key === "Enter" || e.key === "Tab")) {
              const item = mention.items[mention.active];
              if (item) { e.preventDefault(); insertMention(item); }
              else if (e.key === "Enter") { e.preventDefault(); dismissMention(); }
              return;
            }
            if (!duringComposition && e.key === "Escape") { e.preventDefault(); dismissMention(); return; }
          }
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !duringComposition) {
            e.preventDefault(); if (!disabled && !runDisabled && !submitting) onRun();
          }
        }}/>
      {mention && <div ref={mentionMenuRef} className="prompt-mention-menu" style={{ top: mentionTop }} role="listbox" aria-label={t(skillEnabled || references.length ? "Prompt suggestions" : "Project file suggestions")}>
        {mention.loading && <div className="prompt-mention-empty">{t("Searching…")}</div>}
        {!mention.loading && !mention.items.length && <div className="prompt-mention-empty">{skillEnabled || references.length ? t("No matching suggestions") : mention.query.trim() ? t("No matching project files") : t("Enter a file or directory name…")}</div>}
        {mention.items.map((item, index) => <div key={item.kind + ":" + (item.kind === "reference" ? item.id : item.kind === "skill" ? item.source + ":" + item.skillId : item.relativePath)}>
          {(index === 0 || mentionGroup(mention.items[index - 1]) !== mentionGroup(item)) && <div className="prompt-mention-heading">{item.kind === "reference" ? t("Reference content") : item.kind === "skill" ? (item.source === "openworkgraph" ? t("OpenWorkgraph skills") : t("Codex skills")) : t("Project files")}</div>}
          <button type="button" role="option" aria-selected={index === mention.active}
          className={"prompt-mention-item" + (index === mention.active ? " is-active" : "")}
          onMouseDown={e => e.preventDefault()} onClick={() => insertMention(item)} onMouseEnter={() => setMention(current => current ? { ...current, active: index } : current)}>
          {item.kind === "skill" ? <Sparkles size={14}/> : item.kind === "directory" ? <Folder size={14}/> : <FileText size={14}/>}
          <span className="prompt-mention-name">{item.name}</span>
          <span className="prompt-mention-path">{item.kind === "reference" ? "" : item.kind === "skill" ? item.description : item.relativePath}</span>
        </button></div>)}
      </div>}
    </div>
    {children}
    <div className="prompt-status-row">
      <button type="button" className="icon-button prompt-mention-trigger" aria-label={t("Insert mention")} title={t("Insert mention")} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={triggerMention}><AtSign size={16}/></button>
      <p className="prompt-status muted" role={notices.length ? "status" : undefined} aria-hidden={notices.length ? undefined : true}>
        {notices.length ? notices.map((notice, index) => <span key={notice.text}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <span className={notice.warning ? "prompt-status-warning" : undefined}>{notice.text}</span>
        </span>) : t("Placeholder")}
      </p>
    </div>
    <footer><div className="prompt-controls">{controls}</div><button className="primary-button run-button" aria-label={resolvedRunLabel} aria-busy={submitting} title={(submitting ? status : runHint || visibleStatus) || "Ctrl / Cmd + Enter"} disabled={disabled || runDisabled || submitting} onClick={onRun}>{submitting ? <span className="run-submit-progress" role="progressbar" aria-label={status || resolvedRunLabel} /> : <ArrowUp size={16} aria-hidden="true" />}</button></footer>
  </section>;
}
export function QueuePopover({
  adapter,
  snapshot,
  serviceId,
  onLocate,
  onError,
  onClose,
}: BaseProps & {
  snapshot: AdapterSnapshot;
  serviceId: string;
  onLocate(run: Run): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const queue = adapter.getQueue(serviceId);
  const runs = [...queue.runs].sort((a, b) => a.sequence - b.sequence);
  return (
    <section className="queue-popover panel" aria-label={t("Workspace task queue")}>
      <div className="panel-heading">
        <ListTodo size={16} />
        <strong>{t("Workspace task queue")}</strong>
        <button className="icon-button" aria-label={t("Close queue")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <p className="queue-info muted">
        {t("Development simulation · Project FIFO · Capacity {occupied}/{capacity} (read-only)", { occupied: queue.occupied, capacity: queue.capacity })}
      </p>
      {queue.stale && (
        <p className="connection-warning">
          {t("Connection interrupted · Showing the last known queue; status is pending confirmation")}
        </p>
      )}
      <div className="queue-list">
        {runs.length ? (
          runs.map((run) => (
            <article className="queue-row" key={run.id}>
              <button className="queue-locate" onClick={() => onLocate(run)}>
                <strong>
                  {snapshot.graphs
                    .find((g) => g.id === run.graphId)
                    ?.nodes.find((n) => n.id === run.nodeId)?.title ||
                    t("Node removed")}
                </strong>
                <span className="muted">
                  {
                    snapshot.projects.find(
                      (p) =>
                        p.id === run.projectId && p.serviceId === run.serviceId,
                    )?.name
                  }{" "}
                  / {snapshot.graphs.find((g) => g.id === run.graphId)?.name}
                </span>
                <Status run={run} />
              </button>
              {!isTerminal(run.status) && (
                <button
                  className="icon-button"
                  disabled={run.cancelRequested || !queue.connected}
                  aria-label={
                    run.status === "queued" ? t("Cancel queued task") : t("Request task stop")
                  }
                  title={
                    run.status === "queued" ? t("Cancel queued task") : t("Request task stop")
                  }
                  onClick={() => {
                    try {
                      adapter.cancelRun(run.id);
                    } catch (e) {
                      onError(e);
                    }
                  }}
                >
                  <Square size={14} />
                </button>
              )}
            </article>
          ))
        ) : (
          <div className="empty-state">
            <Check size={24} />
            <p>{queue.stale ? t("Queue status unknown") : t("No tasks right now")}</p>
          </div>
        )}
      </div>
    </section>
  );
}
export function RunDetails({
  adapter,
  runs,
  selectedRunId,
  onSelectRun,
  onClose,
  onError,
}: BaseProps & {
  runs: Run[];
  selectedRunId?: string;
  onSelectRun(id: string): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const run = runs.find((r) => r.id === selectedRunId) || runs.at(-1);
  const [answer, setAnswer] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    setAnswer("");
    follow.current = true;
    setPaused(false);
  }, [run?.id, run?.question?.id]);
  useEffect(() => {
    if (follow.current && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.summaries.length]);
  const act = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <aside className="run-details panel" aria-label={t("Run details")}>
      <div className="panel-heading">
        <History size={16} />
        <strong>{t("Run details")}</strong>
        <button
          className="icon-button"
          aria-label={t("Close run details")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {!run ? (
        <div className="empty-state">
          <CircleHelp size={28} />
          <p>{t("No run history")}</p>
          <span className="muted">{t("Enter a prompt, then run it from the original node.")}</span>
        </div>
      ) : (
        <>
          <div className="detail-meta">
            <Status run={run} />
            <span className="dev-label">{t("Development simulation")}</span>
            <label>
              {t("Historical runs")}
              <select
                aria-label={t("Historical runs")}
                value={run.id}
                onChange={(e) => onSelectRun(e.target.value)}
              >
                {[...runs].reverse().map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.sequence} · {t(statusLabels[r.status])} · {r.id.slice(-7)}
                  </option>
                ))}
              </select>
            </label>
            <code>{run.id}</code>
          </div>
          <div
            className="detail-log"
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 28;
              setPaused(!follow.current);
            }}
          >
            {run.summaries.map((line, i) => (
              <div className="log-line" key={i}>
                <span className="log-bullet" />
                <p>{line}</p>
              </div>
            ))}
            {run.error && <p className="error-message">{run.error}</p>}
          </div>
          {paused && (
            <button
              className="secondary-button"
              onClick={() => {
                follow.current = true;
                setPaused(false);
                logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
              }}
            >
              {t("Return to latest")}
            </button>
          )}
          {run.status === "waiting_input" && run.question && (
            <form
              className="interaction-box"
              onSubmit={(e) => {
                e.preventDefault();
                act(() =>
                  adapter.answerInput(run.id, run.question!.id, answer),
                );
              }}
            >
              <strong>{t("Your answer is required")}</strong>
              <p>{run.question.message}</p>
              <textarea
                aria-label={t("Answer question")}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={t("Enter an answer…")}
              />
              <button className="primary-button" disabled={!answer.trim()}>
                {t("Submit answer")}
              </button>
            </form>
          )}
          {run.status === "waiting_approval" && run.approval && (
            <div className="interaction-box">
              <strong>{t("Approval requested")}</strong>
              <p>{run.approval.message}</p>
              <div className="button-row">
                <button
                  className="primary-button"
                  onClick={() =>
                    act(() =>
                      adapter.decideApproval(run.id, run.approval!.id, true),
                    )
                  }
                >
                  {t("Approve")}
                </button>
                <button
                  className="secondary-button"
                  onClick={() =>
                    act(() =>
                      adapter.decideApproval(run.id, run.approval!.id, false),
                    )
                  }
                >
                  {t("Reject")}
                </button>
              </div>
            </div>
          )}
          {run.candidate && (
            <div className="interaction-box">
              <strong>{t("Generated candidate retained")}</strong>
              <p>{t("The content was edited during generation, so the result did not overwrite the current content.")}</p>
              <button
                className="secondary-button"
                onClick={() =>
                  act(() => adapter.applyGenerationCandidate(run.id))
                }
              >
                {t("Use generated candidate")}
              </button>
            </div>
          )}
          <details className="snapshot-details">
            <summary>
              <ChevronRight size={13} />
              {t("Input snapshot · {count} references", { count: run.inputSnapshot.inputs.length })}
            </summary>
            <pre>{run.inputSnapshot.prompt}</pre>
            {run.inputSnapshot.inputs.map((input) => (
              <article key={input.nodeId}>
                <strong>{input.title}</strong>
                <pre>{input.content || t("Media asset reference")}</pre>
                {input.assetRef && (
                  <code>
                    {input.assetRef.assetId} / {input.assetRef.versionId}
                  </code>
                )}
              </article>
            ))}
          </details>
        </>
      )}
    </aside>
  );
}
