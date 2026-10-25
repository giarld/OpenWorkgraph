import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  menu: boolean;
  onDismiss(): void;
};

/** Both entry points use the same action, availability and accessible label. */
export function NodeToolButton({ menu, onDismiss, children, onClick, className, ...props }: Props) {
  return <button {...props} type="button" className={menu ? 'create-option' : (className ?? 'icon-button')} role={menu ? 'menuitem' : undefined}
    onClick={event => { if (menu) onDismiss(); onClick?.(event); }}>
    {children}{menu && <span>{props['aria-label']}</span>}
  </button>;
}
