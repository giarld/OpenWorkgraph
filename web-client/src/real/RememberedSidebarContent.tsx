import { useLayoutEffect, useRef, type ReactNode } from 'react';

const STORAGE_PREFIX = 'openworkgraph:left-sidebar-scroll:v1:';

/** Each sidebar view owns its position, including while its list loads. */
export function RememberedSidebarContent({ viewKey, children }: { viewKey: string; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const element = container.current!;
    const storageKey = STORAGE_PREFIX + viewKey;
    let position = positions.current.get(viewKey) ?? 0;
    if (!positions.current.has(viewKey)) {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        if (typeof saved === 'number' && Number.isFinite(saved) && saved >= 0) position = saved;
      } catch { /* Invalid or unavailable preferences do not block navigation. */ }
    }
    let restoring = true;
    const save = () => {
      if (restoring) return;
      position = element.scrollTop;
      positions.current.set(viewKey, position);
      try { localStorage.setItem(storageKey, JSON.stringify(position)); }
      catch { /* Keep in-memory positions when browser storage is unavailable. */ }
    };
    const restore = () => {
      if (!restoring) return;
      element.scrollTop = position;
      // A loading placeholder may be shorter than the saved position.
      if (Math.abs(element.scrollTop - position) < 1) restoring = false;
    };
    const interrupt = (event: Event) => {
      if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      restoring = false; save();
    };
    element.addEventListener('scroll', save);
    element.addEventListener('wheel', interrupt, { passive: true });
    element.addEventListener('touchstart', interrupt, { passive: true });
    element.addEventListener('pointerdown', interrupt);
    element.addEventListener('keydown', interrupt);
    window.addEventListener('pagehide', save);
    const observer = new ResizeObserver(restore);
    observer.observe(body.current!);
    observer.observe(element);
    restore();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', save);
      element.removeEventListener('wheel', interrupt);
      element.removeEventListener('touchstart', interrupt);
      element.removeEventListener('pointerdown', interrupt);
      element.removeEventListener('keydown', interrupt);
      window.removeEventListener('pagehide', save);
    };
  }, [viewKey]);
  return <div ref={container} className="sidebar-content" style={{ overflowAnchor: 'none' }}><div ref={body}>{children}</div></div>;
}
