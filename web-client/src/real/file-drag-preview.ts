import './FileDragPreview.css';

/** A transparent icon/thumbnail and name, shared by file lists and remote assets. */
export function setFileDragPreview(data: DataTransfer, item: HTMLElement): () => void {
  const preview = item.ownerDocument.createElement('div');
  preview.className = 'ow-file-drag-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.style.width = Math.min(144, Math.max(88, item.getBoundingClientRect().width)) + 'px';
  const thumbnail = item.querySelector('.ow-project-file-tile-icon');
  if (thumbnail) preview.append(thumbnail.cloneNode(true));
  else {
    const icon = item.querySelector('.ow-project-file-icon')?.cloneNode(true) as SVGElement | undefined;
    if (icon) {
      icon.setAttribute('width', '30'); icon.setAttribute('height', '30');
      const container = item.ownerDocument.createElement('span');
      container.className = 'ow-project-file-tile-icon';
      container.append(icon); preview.append(container);
    }
  }
  const label = item.querySelector('.ow-project-file-label');
  if (label) preview.append(label.cloneNode(true));
  // Keep theme inheritance without affecting layout or pointer hit testing.
  item.closest('.ow-project-files-panel')!.append(preview);
  data.setDragImage(preview, preview.getBoundingClientRect().width / 2, 24);
  return () => preview.remove();
}
