import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';

export function NodeContextMenu({ screen, onClose, children }: {
  screen: { x: number; y: number };
  onClose(): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const element = menu.current!;
    const place = () => {
      const bounds = element.getBoundingClientRect(), margin = 12;
      const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - bounds.height - margin);
      const top = screen.y + bounds.height <= window.innerHeight - margin ? screen.y : screen.y - bounds.height - 8;
      setPosition({ left: Math.max(margin, Math.min(screen.x, maxLeft)), top: Math.max(margin, Math.min(top, maxTop)) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [screen]);
  const positioned = Boolean(position);
  useLayoutEffect(() => {
    if (positioned) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [screen, positioned]);
  useLayoutEffect(() => {
    // Observe outside events without covering nodes: a new right-click must
    // reach the canvas's selection and node-specific context-menu handlers.
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('contextmenu', dismissOutside, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('contextmenu', dismissOutside, true);
    };
  }, [onClose]);
  return <div ref={menu} className="create-menu node-context-menu panel" role="menu" aria-label={t('Node actions')}
      style={{ position: 'fixed', left: position?.left ?? 12, top: position?.top ?? 12, visibility: position ? 'visible' : 'hidden' }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      }}>{children}</div>;
}
