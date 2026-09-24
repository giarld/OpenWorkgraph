/** Measure the caret line in textarea layout coordinates, including wrapping and scrolling. */
export function textareaCaretTop(textarea: HTMLTextAreaElement): number {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  for (const property of Array.from(style)) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    left: '0', top: '0', height: 'auto', minHeight: '0', maxHeight: 'none',
    width: `${textarea.clientWidth}px`, boxSizing: 'border-box', border: '0',
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', transform: 'none',
  });
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(textarea.selectionStart) || '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return textarea.offsetTop + textarea.clientTop + top - textarea.scrollTop;
}
