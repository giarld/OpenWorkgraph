import { useEffect, useState } from "react";
import { isTerminalRunStatus, type InputSnapshot } from "../../../packages/protocol/src/index";
import type { Request, Run } from "./contracts";
import { runProgressPreview, type RunProgressHistory } from "./run-progress";
import { translate } from "../i18n/translate";

type ProgressRows = Record<string, { summaries: string[]; error?: string }>;

export const sameProgressRows = (left: ProgressRows, right: ProgressRows) => {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length && leftIds.every(id => {
    const a = left[id];
    const b = right[id];
    return !!b && a.error === b.error && a.summaries.length === b.summaries.length &&
      a.summaries.every((summary, index) => summary === b.summaries[index]);
  });
};

/** History progress is durable but does not emit run.changed; poll only while active. */
export function useRunProgress(request: Request, runs: Run[], online: boolean, revision: number) {
  const [cache, setCache] = useState<{ request: Request; rows: ProgressRows }>();
  const stamp = JSON.stringify(runs.map(run => [run.id, run.status, run.historyState]));
  useEffect(() => {
    if (!online) return;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const latest = [...new Map(runs.filter(r => !!r.id).map(r => [r.nodeId, r])).values()];
    const refresh = async () => {
      const rows = await Promise.all(latest.map(async (run): Promise<[string, { summaries: string[]; error?: string }]> => {
        try { const history = await request<RunProgressHistory>("/v1/runs/" + encodeURIComponent(run.id) + "/history"); return [run.id, { summaries: runProgressPreview(history) }]; }
        catch { return [run.id, { summaries: [], error: translate("Progress could not be read. Waiting to reconnect.") }]; }
      }));
      if (!live) return;
      setCache(previous => {
        const nextRows = Object.fromEntries(rows.map(([id, row]) => [id, row.error && previous?.request === request ? { ...row, summaries: previous.rows[id]?.summaries ?? [] } : row]));
        return previous?.request === request && sameProgressRows(previous.rows, nextRows)
          ? previous
          : { request, rows: nextRows };
      });
      if (latest.some(run => !isTerminalRunStatus(run.status))) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [request, online, stamp, revision]);
  return cache?.request === request ? cache.rows : {};
}

/** Submitted prompts are immutable run input, so read each latest node Run once per run list change. */
export function useRunPrompts(request: Request, runs: Run[], online: boolean, revision: number) {
  const [cache, setCache] = useState<{ request: Request; rows: Record<string, string> }>();
  const stamp = JSON.stringify(runs.map(run => [run.id, run.inputDigest]));
  useEffect(() => {
    if (!online) return;
    let live = true;
    const latest = [...new Map(runs.filter(run => !!run.id).map(run => [run.nodeId, run])).values()];
    void Promise.all(latest.map(async (run): Promise<[string, string] | null> => {
      try {
        const snapshot = await request<InputSnapshot>("/v1/runs/" + encodeURIComponent(run.id) + "/snapshot");
        return [run.id, snapshot.prompt];
      } catch {
        return null;
      }
    })).then(rows => {
      if (!live) return;
      setCache(previous => ({
        request,
        rows: {
          ...(previous?.request === request ? previous.rows : {}),
          ...Object.fromEntries(rows.filter((row): row is [string, string] => row !== null)),
        },
      }));
    });
    return () => { live = false; };
  }, [request, online, stamp, revision]);
  return cache?.request === request ? cache.rows : {};
}

export function useInputChanges(request: Request, run: Run | undefined, online: boolean, revision: number) {
  const [result, setResult] = useState<{ request: Request; id: string; changed: boolean }>();
  useEffect(() => {
    let live = true;
    if (!online || !run?.id) return;
    request<{ state: string }>("/v1/runs/" + encodeURIComponent(run.id) + "/input-changes").then(value => {
      if (live) setResult({ request, id: run.id, changed: value.state === "changed" });
    }).catch(() => { if (live) setResult(undefined); });
    return () => { live = false; };
  }, [request, run?.id, run?.status, online, revision]);
  return result?.request === request && result.id === run?.id && result.changed;
}
