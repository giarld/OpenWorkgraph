import { useLayoutEffect, useState, type RefObject } from 'react';

/** Measure the outer node, before the iframe's rendering-density compensation. */
export function useVisualizeDetail(box: RefObject<HTMLDivElement | null>, expanded: boolean) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = box.current?.closest<HTMLElement>('[data-node-id]');
    const world = node?.closest<HTMLElement>('.owg-world');
    if (expanded || !node || !world) { setCompact(false); return; }
    let small = false, frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = node.getBoundingClientRect();
      const ratio = Math.min(bounds.width / window.innerWidth, bounds.height / window.innerHeight);
      const next = ratio < (small ? 0.09 : 0.075);
      if (next !== small) { small = next; setCompact(next); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    // Panning does not change detail level; avoid node geometry reads on pan frames.
    let scale = world.style.transform.match(/scale\(([^)]+)\)/)?.[1];
    const transform = new MutationObserver(() => {
      const next = world.style.transform.match(/scale\(([^)]+)\)/)?.[1];
      if (next !== scale) { scale = next; schedule(); }
    });
    transform.observe(world, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      resize.disconnect(); transform.disconnect();
      window.removeEventListener('resize', schedule); cancelAnimationFrame(frame);
    };
  }, [box, expanded]);
  return compact;
}
