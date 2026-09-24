// Browser platform, not the dev server host, determines the primary shortcut key.
export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const primaryKey = isMac ? "Meta" : "Control";
export const primaryLabel = isMac ? "Command" : "Ctrl";
export function primaryModifier(event: { metaKey: boolean; ctrlKey: boolean }) {
  return isMac ? event.metaKey : event.ctrlKey;
}
