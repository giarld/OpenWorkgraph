import { RefreshCw } from 'lucide-react';
import './RefreshIcon.css';

/** Optional request feedback; animationKey still triggers the manual refresh flourish. */
export function RefreshIcon({ animationKey, spinning = false }: { animationKey: number; spinning?: boolean }) {
  return <RefreshCw key={animationKey} size={16} aria-hidden="true" className={spinning ? 'ow-refresh-icon-loading' : animationKey > 0 ? 'ow-refresh-icon-spinning' : undefined} />;
}
