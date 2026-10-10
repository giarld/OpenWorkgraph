import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// Dialogs and other previews outside the Work Graph remain active by default.
const NodeViewportContext = createContext(true);
export const useNodeViewport = () => useContext(NodeViewportContext);

/** Defer expensive content, then retain its DOM and resources while offscreen. */
export function NodeViewport({ render, contentKey }: { render: () => ReactNode; contentKey: unknown }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const retained = useRef<ReactNode>(null);
  const playing = useRef(new Set<HTMLMediaElement>());
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      // At threshold zero, edge contact is intersecting. Filtering out its
      // zero-area rectangle would miss the subsequent move into the viewport.
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { root: element.closest('.owg-canvas') });
    observer.observe(element.closest('.owg-node') ?? element);
    return () => observer.disconnect();
  }, []);
  // contentKey carries the host's renderer dependencies. Keep the previous
  // element tree while hidden, and apply the latest inputs on the next entry.
  const content = useMemo(() => visible ? render() : retained.current, [visible, contentKey]);
  useLayoutEffect(() => { if (visible) retained.current = content; }, [visible, content]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (visible) {
      for (const media of playing.current) if (media.isConnected) void media.play().catch(() => undefined);
      playing.current.clear();
      return;
    }
    const pause = (media: HTMLMediaElement) => {
      playing.current.add(media);
      media.pause();
    };
    for (const media of element.querySelectorAll<HTMLMediaElement>('video,audio')) if (!media.paused) pause(media);
    const onPlay = (event: Event) => { if (event.target instanceof HTMLMediaElement) pause(event.target); };
    element.addEventListener('play', onPlay, true);
    return () => element.removeEventListener('play', onPlay, true);
  }, [visible]);
  return <div ref={container} className="owg-node-viewport" data-node-viewport-active={visible}>
    <NodeViewportContext.Provider value={visible}>{content}</NodeViewportContext.Provider>
  </div>;
}
