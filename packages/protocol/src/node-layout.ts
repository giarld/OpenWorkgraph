import { VISUALIZE_DEFAULT_SIZE } from './visualize.js';

/** Shared defaults for ordinary creation, display fallback and host-created nodes. */
export function defaultWorkgraphNodeSize(type: string): { width: number; height: number } {
  if (type === 'preview' || type === 'visualize') return { ...VISUALIZE_DEFAULT_SIZE };
  return { width: 300, height: type === 'execution' ? 330 : 220 };
}
