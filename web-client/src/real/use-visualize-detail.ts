import { useLayoutEffect, useState, type RefObject } from 'react';

/** Only Work Graph zoom controls detail level, independently of node or window size. */
export function useVisualizeDetail(box: RefObject<HTMLDivElement | null>, expanded: boolean) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const world = box.current?.closest<HTMLElement>('.owg-world');
    if (expanded || !world) { setCompact(false); return; }
    const readScale = () => Number(world.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
    // Enter Logo mode below 20%; keep it until zoom reaches 25%.
    const updateCompact = (scale: number) => setCompact(previous => scale < (previous ? 0.25 : 0.2));
    let scale = readScale();
    updateCompact(scale);
    // Panning does not change detail level; no geometry reads are needed.
    const transform = new MutationObserver(() => {
      const next = readScale();
      if (next !== scale) { scale = next; updateCompact(next); }
    });
    transform.observe(world, { attributes: true, attributeFilter: ['style'] });
    return () => transform.disconnect();
  }, [box, expanded]);
  return compact;
}
