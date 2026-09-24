import type { ReactNode } from 'react';

/** Shared viewport and stationary footer for built-in and plugin previews. */
export function PreviewLayout({children,footer,scrollable=true,className=''}: {children:ReactNode;footer?:ReactNode;scrollable?:boolean;className?:string}) {
  return <div className={'ow-preview-layout ' + className}>
    <div className={scrollable ? 'ow-preview-scroll' : 'ow-preview-fill'}>{children}</div>
    {footer && <div className="ow-preview-footer">{footer}</div>}
  </div>;
}
