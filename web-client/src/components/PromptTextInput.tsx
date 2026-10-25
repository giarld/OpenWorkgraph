import type { SkillReference } from "../../../packages/protocol/src/skills";
import { skillSourceLabel, skillIdentityKey } from "../../../packages/protocol/src/skills";
import { useLayoutEffect, useRef, useImperativeHandle, type Ref, type KeyboardEvent, type DragEvent } from 'react';
import { syncSkillReferences, validSkillReferences, type PromptEdit, type ProjectFileMentionCandidate } from '../real/project-file-mentions';
import { promptMentionTokens, promptMentionIconPath } from './prompt-mentions';

export interface PromptTextInputHandle {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  insertText(text: string): void;
  focus(): void;
  element: HTMLDivElement | null;
  caretTop(): number;
}

function textOf(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.mention !== undefined) return node.dataset.mention;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return (node as HTMLElement).hasAttribute('data-trailing-break') ? '' : '\n';
  return Array.from(node.childNodes).map((child, index) => {
    const block = child.nodeName === 'DIV' || child.nodeName === 'P';
    const text = block && child.childNodes.length === 1 && child.firstChild?.nodeName === 'BR' ? '' : textOf(child);
    return (block && index > 0 ? '\n' : '') + text;
  }).join('');
}
function selection(root: HTMLElement): [number, number] {
  const current = window.getSelection();
  if (!current?.rangeCount || !root.contains(current.anchorNode) || !root.contains(current.focusNode)) return [textOf(root).length, textOf(root).length];
  const offset = (node: Node, index: number) => {
    const range = document.createRange(); range.setStart(root, 0); range.setEnd(node, index);
    return textOf(range.cloneContents()).length;
  };
  const range = current.getRangeAt(0);
  return [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
}
function caretRect(root: HTMLElement, node: Node, offset: number): DOMRect | undefined {
  const range = document.createRange();
  range.setStart(node, offset); range.collapse(true);
  const rect = Array.from(range.getClientRects()).find(rect => rect.height > 0);
  if (rect) return rect;
  // Empty lines and positions beside atomic mentions may have no Range rect.
  // Measure a marker in a clone so the live DOM, selection and IME stay intact.
  const path: number[] = [];
  for (let child = node; child !== root; child = child.parentNode!) {
    path.unshift(Array.prototype.indexOf.call(child.parentNode!.childNodes, child));
  }
  const mirror = root.cloneNode(true) as HTMLElement;
  mirror.removeAttribute('id'); mirror.setAttribute('aria-hidden', 'true');
  mirror.contentEditable = 'false'; mirror.tabIndex = -1;
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
    left: `${root.offsetLeft}px`, top: `${root.offsetTop}px`,
    width: `${root.offsetWidth}px`, height: `${root.offsetHeight}px`, margin: '0',
  });
  let target: Node = mirror;
  for (const index of path) target = target.childNodes[index];
  range.setStart(target, offset); range.collapse(true);
  const marker = document.createElement('span'); marker.textContent = '\u200b';
  range.insertNode(marker);
  root.parentElement!.append(mirror);
  mirror.scrollTop = root.scrollTop;
  const measured = marker.getBoundingClientRect();
  // Translate from the mirror's position, including ancestor transforms.
  const mirrorBounds = mirror.getBoundingClientRect();
  const bounds = root.getBoundingClientRect();
  const result = new DOMRect(measured.x + bounds.x - mirrorBounds.x, measured.y + bounds.y - mirrorBounds.y, measured.width, measured.height);
  mirror.remove();
  return result;
}
function revealCaret(root: HTMLElement) {
  const current = window.getSelection();
  if (!current?.focusNode || !root.contains(current.focusNode)) return;
  const rect = caretRect(root, current.focusNode, current.focusOffset);
  const bounds = root.getBoundingClientRect();
  const scale = bounds.height / root.offsetHeight;
  if (!rect || !scale) return;
  const style = getComputedStyle(root);
  const top = bounds.top + (root.clientTop + parseFloat(style.paddingTop)) * scale;
  const bottom = bounds.top + (root.clientTop + root.clientHeight - parseFloat(style.paddingBottom)) * scale;
  if (rect.bottom > bottom) root.scrollTop += (rect.bottom - bottom) / scale;
  else if (rect.top < top) root.scrollTop -= (top - rect.top) / scale;
}
function select(root: HTMLElement, start: number, end: number) {
  const point = (position: number): [Node, number] => {
    let remaining = position;
    for (let index = 0; index < root.childNodes.length; index++) {
      const node = root.childNodes[index]; const length = textOf(node).length;
      if (remaining <= length) {
        if (node.nodeType === Node.TEXT_NODE) return [node, remaining];
        return [root, index + (remaining > 0 ? 1 : 0)];
      }
      remaining -= length;
    }
    return [root, root.childNodes.length];
  };
  const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end));
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  revealCaret(root);
}
function render(root: HTMLElement, value: string, skills: boolean, skillReferences: SkillReference[], skillNames: readonly string[], onOpenFile?: (item: ProjectFileMentionCandidate) => void, onOpenReference?: (id: string) => void, skillBackendNames: Readonly<Record<string, string>> = {}, skillConflictReasons: Readonly<Record<string, string>> = {}) {
  const fragment = document.createDocumentFragment(); let cursor = 0;
  for (const token of promptMentionTokens(value, skills, skillReferences, skillNames)) {
    fragment.append(document.createTextNode(value.slice(cursor, token.start)));
    const chip = document.createElement('span'); chip.contentEditable = 'false'; chip.className = 'prompt-mention-token';
    const reference = skillReferences.find(ref => ref.start === token.start && ref.end === token.end);
    if (reference) { chip.dataset.skillId = reference.skillId; chip.dataset.skillSource = reference.source; if (reference.source === 'agent') chip.dataset.skillBackendId = reference.backendId; }
    const conflict = reference && skillConflictReasons[skillIdentityKey(reference)];
    if (conflict) {
      chip.classList.add('prompt-skill-conflict'); chip.tabIndex = 0; chip.setAttribute('role', 'button'); chip.setAttribute('aria-expanded', 'false');
      const toggle = () => { const expanded = chip.classList.toggle('show-conflict'); chip.setAttribute('aria-expanded', String(expanded)); };
      chip.addEventListener('click', toggle);
      chip.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggle(); } });
    }
    chip.dataset.mention = token.raw; chip.dataset.kind = token.kind; chip.title = reference ? token.name + ' · ' + skillSourceLabel(reference, skillBackendNames) : token.path ?? token.name; chip.setAttribute('aria-label', token.name + (conflict ? ' · ' + conflict : '')); if (conflict) chip.title += ' · ' + conflict;
    if ((token.path && onOpenFile) || (token.id && onOpenReference)) {
      chip.setAttribute('role', 'button'); chip.tabIndex = 0;
      const open = () => token.id ? onOpenReference?.(token.id) : onOpenFile?.({ name: token.name, relativePath: token.path!, kind: token.kind as 'file' | 'directory' });
      chip.addEventListener('click', open);
      chip.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); }
      });
    }
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', '14'); icon.setAttribute('height', '14');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', promptMentionIconPath(token.kind));
    if (conflict) path.setAttribute('d', 'M12 9v4M12 17h.01M10.3 3.9 1.8 18.6a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z');
    icon.append(path); chip.append(icon, document.createTextNode(token.name));
    if (conflict) { const reason = document.createElement('span'); reason.className = 'prompt-skill-conflict-reason'; reason.textContent = conflict; chip.append(reason); }
    fragment.append(chip); cursor = token.end;
  }
  fragment.append(document.createTextNode(value.slice(cursor)));
  if (value.endsWith('\n')) { const tail = document.createElement('br'); tail.setAttribute('data-trailing-break', ''); fragment.append(tail); }
  root.replaceChildren(fragment);
}

/** DOM mentions are atomic; persisted prompts remain Markdown and Codex skill text. */
export function PromptTextInput({ ref, value, disabled, skillEnabled, skillReferences = [], skillNames = [], skillBackendNames = {}, skillConflictReasons = {}, label, placeholder, onChange, onSelect, onScroll, onBlur, onCompositionStart, onCompositionEnd, onKeyDown, onDragOver, onDrop, onOpenFile, onOpenReference }: {
  onOpenReference?: (id: string) => void;
  onOpenFile?: (item: ProjectFileMentionCandidate) => void;
  ref: Ref<PromptTextInputHandle>; value: string; disabled: boolean; skillEnabled: boolean; label: string; placeholder?: string;
  skillReferences?: SkillReference[];
  skillNames?: readonly string[];
  skillBackendNames?: Readonly<Record<string, string>>;
  skillConflictReasons?: Readonly<Record<string, string>>;
  onChange(value: string, cursor: number, skillReferences: SkillReference[]): void; onSelect(): void; onScroll(): void; onBlur(): void;
  onCompositionStart(): void; onCompositionEnd(value: string, cursor: number): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void; onDrop(event: DragEvent<HTMLDivElement>): void;
}) {
  const root = useRef<HTMLDivElement>(null); const composing = useRef(false);
  const history = useRef<{ value: string; caret: number; refs: SkillReference[] }[]>([]); const future = useRef<{ value: string; caret: number; refs: SkillReference[] }[]>([]);
  const current = useRef(value);
  const currentRefs = useRef(validSkillReferences(value, skillReferences));
  const nativeEdit = useRef<{ value: string; start: number; end: number } | null>(null);
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const openFile = onOpenFile ? (item: ProjectFileMentionCandidate) => openFileRef.current?.(item) : undefined;
  const openReferenceRef = useRef(onOpenReference);
  openReferenceRef.current = onOpenReference;
  const openReference = onOpenReference ? (id: string) => openReferenceRef.current?.(id) : undefined;
  const renderedConfig = useRef('');
  const config = String(skillEnabled) + ':' + String(!!onOpenFile) + ':' + String(!!onOpenReference) + ':' + JSON.stringify(skillReferences) + ':' + JSON.stringify(skillNames) + ':' + JSON.stringify(skillBackendNames) + ':' + JSON.stringify(skillConflictReasons);
  const api: PromptTextInputHandle = {
    get element() { return root.current; }, get value() { return root.current ? textOf(root.current) : value; },
    get selectionStart() { return root.current ? selection(root.current)[0] : 0; }, get selectionEnd() { return root.current ? selection(root.current)[1] : 0; },
    focus() { root.current?.focus(); }, setSelectionRange(start, end) { if (root.current) select(root.current, start, end); },
    insertText(text) { if (!disabled && !composing.current) replace(text); },
    caretTop() {
      const element = root.current!;
      const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
      if (range && element.contains(range.startContainer)) { range.collapse(true); const rect = range.getClientRects()[0]; if (rect) return rect.top - element.parentElement!.getBoundingClientRect().top; }
      return element.offsetTop + parseFloat(getComputedStyle(element).paddingTop);
    },
  };
  useImperativeHandle(ref, () => api);
  useLayoutEffect(() => {
    const element = root.current!; if (composing.current) return;
    if (current.current !== value || JSON.stringify(currentRefs.current) !== JSON.stringify(validSkillReferences(value, skillReferences))) { history.current.push({ value: current.current, caret: api.selectionStart, refs: currentRefs.current }); history.current = history.current.slice(-100); future.current = []; }
    const caret = selection(element);
    if (textOf(element) !== value || !element.childNodes.length || renderedConfig.current !== config) { render(element, value, skillEnabled, validSkillReferences(value, skillReferences), skillNames, openFile, openReference, skillBackendNames, skillConflictReasons); if (document.activeElement === element) select(element, ...caret); }
    current.current = value;
    currentRefs.current = validSkillReferences(value, skillReferences);
    renderedConfig.current = config;
  }, [value, config]);
  const commit = (next: string, start: number, previousCaret = api.selectionStart, edit?: PromptEdit, restoredRefs?: SkillReference[]) => {
    if (next !== current.current) root.current?.dispatchEvent(new Event('owg-prompt-edit', { bubbles: true }));
    const captured = nativeEdit.current;
    if (!edit && captured?.value === current.current) edit = { start: captured.start, end: captured.end, text: next.slice(captured.start, next.length - (captured.value.length - captured.end)) };
    nativeEdit.current = null;
    const refs = restoredRefs ?? syncSkillReferences(current.current, next, currentRefs.current, edit);
    if (!composing.current && (next !== current.current || JSON.stringify(refs) !== JSON.stringify(currentRefs.current))) { history.current.push({ value: current.current, caret: previousCaret, refs: currentRefs.current }); history.current = history.current.slice(-100); future.current = []; }
    if (!composing.current) { current.current = next; currentRefs.current = refs; }
    if (!composing.current) { render(root.current!, next, skillEnabled, refs, skillNames, openFile, openReference, skillBackendNames, skillConflictReasons); select(root.current!, start, start); }
    onChange(next, start, refs);
  };
  const replace = (text: string, backward = false, forward = false, pastedRefs: SkillReference[] = []) => {
    const source = api.value; let [start, end] = selection(root.current!); const previousCaret = start;
    if (start === end) {
      if (backward) start = Math.max(0, start - (source.codePointAt(start - 2)! > 0xffff ? 2 : 1));
      if (forward) end = Math.min(source.length, end + (source.codePointAt(end)! > 0xffff ? 2 : 1));
    }
    for (const token of promptMentionTokens(source, skillEnabled, currentRefs.current, skillNames)) if (start < token.end && end > token.start) { start = Math.min(start, token.start); end = Math.max(end, token.end); }
    const next = source.slice(0, start) + text + source.slice(end);
    const edit = { start, end, text };
    const refs = validSkillReferences(next, [...syncSkillReferences(source, next, currentRefs.current, edit), ...pastedRefs.map(ref => ({ ...ref, start: ref.start + start, end: ref.end + start }))]);
    commit(next, start + text.length, previousCaret, edit, refs);
  };
  const undo = (redo: boolean) => {
    const from = redo ? future.current : history.current; const to = redo ? history.current : future.current; const state = from.pop(); if (!state) return;
    if (state.value !== current.current) root.current?.dispatchEvent(new Event('owg-prompt-edit', { bubbles: true }));
    to.push({ value: api.value, caret: api.selectionStart, refs: currentRefs.current }); current.current = state.value; currentRefs.current = state.refs;
    render(root.current!, state.value, skillEnabled, state.refs, skillNames, openFile, openReference, skillBackendNames, skillConflictReasons); select(root.current!, state.caret, state.caret); onChange(state.value, state.caret, state.refs);
  };
  return <div ref={root} className="prompt-text-input" role="textbox" aria-label={label} aria-placeholder={placeholder} aria-multiline="true" aria-disabled={disabled} data-placeholder={placeholder}
    contentEditable={!disabled} suppressContentEditableWarning tabIndex={disabled ? -1 : 0}
    onInput={() => {
      // Finish the browser's native selection update before replacing its DOM.
      // Mutating inside input can leave the newly inserted text selected.
      queueMicrotask(() => { if (root.current) commit(api.value, api.selectionStart); });
    }}
    onCompositionStart={() => { composing.current = true; onCompositionStart(); }}
    onCompositionEnd={() => { composing.current = false; commit(api.value, api.selectionStart); onCompositionEnd(api.value, api.selectionStart); }}
    onSelect={onSelect} onKeyUp={() => { if (root.current && !composing.current) revealCaret(root.current); onSelect(); }} onScroll={onScroll} onBlur={onBlur} onDragOver={onDragOver} onDrop={onDrop}
    onBeforeInput={event => {
      if (disabled) { event.preventDefault(); return; }
      const type = (event.nativeEvent as InputEvent).inputType;
      const [start, end] = selection(root.current!);
      if (!nativeEdit.current) nativeEdit.current = { value: api.value, start, end };
      if (composing.current) return;
      if (type === 'deleteContentBackward' || type === 'deleteContentForward') { event.preventDefault(); replace('', type === 'deleteContentBackward', type === 'deleteContentForward'); }
      if (type === 'historyUndo' || type === 'historyRedo') { event.preventDefault(); undo(type === 'historyRedo'); }
    }}
    onKeyDown={event => {
      onKeyDown(event);
      if (event.defaultPrevented || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || disabled) return;
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) { event.preventDefault(); undo(event.shiftKey || event.key.toLowerCase() === 'y'); return; }
      if (event.key === 'Enter') { event.preventDefault(); replace('\n'); }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault(); replace('', event.key === 'Backspace', event.key === 'Delete');
      }
    }}
    onPaste={event => {
      event.preventDefault(); if (disabled) return;
      const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
      let refs: SkillReference[] = [];
      try { const payload = JSON.parse(event.clipboardData.getData('application/x-openworkgraph-prompt')); if (payload.value === text) refs = validSkillReferences(text, payload.skillReferences); } catch { /* Ordinary text paste. */ }
      replace(text, false, false, refs);
    }}
    onCopy={event => { const [start, end] = selection(root.current!); if (start !== end) { event.preventDefault(); const text = api.value.slice(start, end);
      event.clipboardData.setData('text/plain', text);
      event.clipboardData.setData('application/x-openworkgraph-prompt', JSON.stringify({ value: text, skillReferences: currentRefs.current.filter(ref => ref.start >= start && ref.end <= end).map(ref => ({ ...ref, start: ref.start - start, end: ref.end - start })) })); } }}
    onCut={event => { const [start, end] = selection(root.current!); if (start !== end) { event.preventDefault(); const text = api.value.slice(start, end);
      event.clipboardData.setData('text/plain', text);
      event.clipboardData.setData('application/x-openworkgraph-prompt', JSON.stringify({ value: text, skillReferences: currentRefs.current.filter(ref => ref.start >= start && ref.end <= end).map(ref => ({ ...ref, start: ref.start - start, end: ref.end - start })) })); if (!disabled) replace(''); } }}
  />;
}
