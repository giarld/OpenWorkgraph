import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphSnapshot } from './contracts';
import { TemporaryCanvasStore } from './temporary-store';
import { createTemporaryServiceBridge, type TemporaryServiceBinding } from './temporary-service-bridge';

/** Browser persistence only; all navigation and rendering belong to RealApp. */
export function useTemporaryCanvases(onError: (error: unknown) => void) {
  const [store] = useState(() => new TemporaryCanvasStore());
  const [graphs, setGraphs] = useState<GraphSnapshot[]>([]);
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem('openworkgraph:temporary:selected') ?? ''; } catch { return ''; }
  });
  const [revision, setRevision] = useState(0);
  const boot = useRef<Promise<GraphSnapshot[]> | undefined>(undefined);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    const rows = await store.list();
    if (ticket !== sequence.current) return;
    setGraphs(rows);
    setRevision(n => n + 1);
  }, [store]);
  const acceptCreated = useCallback((graph: GraphSnapshot) => {
    // A list read started before creation must not remove the new snapshot.
    ++sequence.current;
    setGraphs(rows => [...rows.filter(row => row.graphId !== graph.graphId), graph]);
    setRevision(n => n + 1);
  }, []);
  useEffect(() => {
    let alive = true;
    const ticket = ++sequence.current;
    boot.current ??= store.list().then(async rows => rows.length ? rows : [await store.create()]);
    void boot.current.then(rows => { if (alive && ticket === sequence.current) setGraphs(rows); }).catch(onError);
    const focus = () => { void refresh().catch(onError); };
    window.addEventListener('focus', focus);
    return () => { alive = false; ++sequence.current; window.removeEventListener('focus', focus); };
  }, [store, refresh, onError]);
  useEffect(() => {
    try { localStorage.setItem('openworkgraph:temporary:selected', selected); } catch { /* IndexedDB stores the canvas independently. */ }
  }, [selected]);
  // The caller owns the service/project selection. Binding never migrates a graph.
  const bridgeFor = useCallback((graphId: string, binding?: TemporaryServiceBinding) => createTemporaryServiceBridge(store, graphId, binding), [store]);
  return { store, graphs, selected, select: setSelected, revision, refresh, acceptCreated, bridgeFor };
}
