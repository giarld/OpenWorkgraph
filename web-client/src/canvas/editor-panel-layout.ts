import type { Rect } from './geometry';

export const EDITOR_PANEL_STORAGE_KEY = 'openworkgraph:editor-panel:v1';

export function readEditorPanel(storage: Pick<Storage, 'getItem'>): Rect | null {
  try {
    const value = JSON.parse(storage.getItem(EDITOR_PANEL_STORAGE_KEY) ?? 'null');
    if (!value || !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) ||
      value.width <= 0 || value.height <= 0) return null;
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  } catch { return null; }
}

/** Clamp the displayed layout, preserving the saved preference for larger windows. */
export function fitEditorPanel(preferred: Rect, area: Rect): Rect {
  const width = Math.min(Math.max(320, preferred.width), Math.max(1, area.width));
  const height = Math.min(Math.max(260, preferred.height), Math.max(1, area.height));
  return { width, height,
    x: Math.max(area.x, Math.min(preferred.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(preferred.y, area.y + area.height - height)),
  };
}

/** Pick a free region around the movable editor for input-triggered node focus. */
export function editorFreeArea(area: Rect, panel: Rect): Rect {
  const gap = 24;
  const candidates = [
    { ...area, height: Math.max(0, panel.y - gap - area.y) },
    { ...area, y: panel.y + panel.height + gap, height: Math.max(0, area.y + area.height - panel.y - panel.height - gap) },
    { ...area, width: Math.max(0, panel.x - gap - area.x) },
    { ...area, x: panel.x + panel.width + gap, width: Math.max(0, area.x + area.width - panel.x - panel.width - gap) },
  ];
  const largest = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return largest.width > 0 && largest.height > 0 ? largest : area;
}
