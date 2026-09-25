import { useLayoutEffect, useRef, useImperativeHandle, type Ref, type KeyboardEvent, type DragEvent } from 'react';
import { extractProjectFileMarkdownLinks, type ProjectFileMentionCandidate } from '../real/project-file-mentions';

export interface PromptTextInputHandle {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  element: HTMLDivElement | null;
  caretTop(): number;
}

type Token = { start: number; end: number; raw: string; name: string; kind: string; path?: string };
function tokens(value: string, skills: boolean): Token[] {
  const result: Token[] = [];
  const pattern = /\[((?:\\.|[^\]])*)\]\((?:<((?:\\.|[^>\r\n])*)>|([^)\s]+))\)/g;
  for (const match of value.matchAll(pattern)) {
    const item = extractProjectFileMarkdownLinks(match[0])[0];
    if (item) result.push({ start: match.index!, end: match.index! + match[0].length, raw: match[0], ...item, path: item.relativePath });
  }
  if (skills) for (const match of value.matchAll(/(?:^|\s)(\$[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)(?=$|\s|[.,!?;，。！？；])/g)) {
    const start = match.index! + match[0].length - match[1].length;
    if (!result.some(token => start >= token.start && start < token.end)) result.push({ start, end: start + match[1].length, raw: match[1], name: match[1], kind: 'skill' });
  }
  return result.sort((a, b) => a.start - b.start);
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
  const rect = range.getClientRects()[0];
  const bounds = root.getBoundingClientRect();
  if (rect && rect.bottom > bounds.bottom) root.scrollTop += rect.bottom - bounds.bottom;
  else if (rect && rect.top < bounds.top) root.scrollTop -= bounds.top - rect.top;
}
function render(root: HTMLElement, value: string, skills: boolean, onOpenFile?: (item: ProjectFileMentionCandidate) => void) {
  const fragment = document.createDocumentFragment(); let cursor = 0;
  for (const token of tokens(value, skills)) {
    fragment.append(document.createTextNode(value.slice(cursor, token.start)));
    const chip = document.createElement('span'); chip.contentEditable = 'false'; chip.className = 'prompt-mention-token';
    chip.dataset.mention = token.raw; chip.dataset.kind = token.kind; chip.title = token.path ?? token.name; chip.setAttribute('aria-label', token.name);
    if (token.path && onOpenFile) {
      chip.setAttribute('role', 'button'); chip.tabIndex = 0;
      const open = () => onOpenFile({ name: token.name, relativePath: token.path!, kind: token.kind as 'file' | 'directory' });
      chip.addEventListener('click', open);
      chip.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); }
      });
    }
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', '14'); icon.setAttribute('height', '14');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', token.kind === 'skill' ? 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' : token.kind === 'directory' ? 'M3 7V5h6l2 2h10v13H3Z' : 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h6');
    icon.append(path); chip.append(icon, document.createTextNode(token.name)); fragment.append(chip); cursor = token.end;
  }
  fragment.append(document.createTextNode(value.slice(cursor)));
  if (value.endsWith('\n')) { const tail = document.createElement('br'); tail.setAttribute('data-trailing-break', ''); fragment.append(tail); }
  root.replaceChildren(fragment);
}

/** DOM mentions are atomic; persisted prompts remain Markdown and Codex skill text. */
export function PromptTextInput({ ref, value, disabled, skillEnabled, label, placeholder, onChange, onSelect, onScroll, onBlur, onCompositionStart, onCompositionEnd, onKeyDown, onDragOver, onDrop, onOpenFile }: {
  onOpenFile?: (item: ProjectFileMentionCandidate) => void;
  ref: Ref<PromptTextInputHandle>; value: string; disabled: boolean; skillEnabled: boolean; label: string; placeholder?: string;
  onChange(value: string, cursor: number): void; onSelect(): void; onScroll(): void; onBlur(): void;
  onCompositionStart(): void; onCompositionEnd(value: string, cursor: number): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void; onDrop(event: DragEvent<HTMLDivElement>): void;
}) {
  const root = useRef<HTMLDivElement>(null); const composing = useRef(false);
  const history = useRef<{ value: string; caret: number }[]>([]); const future = useRef<{ value: string; caret: number }[]>([]);
  const current = useRef(value);
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const openFile = onOpenFile ? (item: ProjectFileMentionCandidate) => openFileRef.current?.(item) : undefined;
  const renderedConfig = useRef('');
  const config = String(skillEnabled) + ':' + String(!!onOpenFile);
  const api: PromptTextInputHandle = {
    get element() { return root.current; }, get value() { return root.current ? textOf(root.current) : value; },
    get selectionStart() { return root.current ? selection(root.current)[0] : 0; }, get selectionEnd() { return root.current ? selection(root.current)[1] : 0; },
    focus() { root.current?.focus(); }, setSelectionRange(start, end) { if (root.current) select(root.current, start, end); },
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
    if (current.current !== value) { history.current.push({ value: current.current, caret: api.selectionStart }); history.current = history.current.slice(-100); future.current = []; }
    const caret = selection(element);
    if (textOf(element) !== value || !element.childNodes.length || renderedConfig.current !== config) { render(element, value, skillEnabled, openFile); if (document.activeElement === element) select(element, ...caret); }
    current.current = value;
    renderedConfig.current = config;
  }, [value, config]);
  const commit = (next: string, start: number, previousCaret = api.selectionStart) => {
    if (!composing.current && next !== current.current) { history.current.push({ value: current.current, caret: previousCaret }); history.current = history.current.slice(-100); future.current = []; }
    if (!composing.current) current.current = next;
    if (!composing.current) { render(root.current!, next, skillEnabled, openFile); select(root.current!, start, start); }
    onChange(next, start);
  };
  const replace = (text: string, backward = false, forward = false) => {
    const source = api.value; let [start, end] = selection(root.current!); const previousCaret = start;
    if (start === end) {
      if (backward) start = Math.max(0, start - (source.codePointAt(start - 2)! > 0xffff ? 2 : 1));
      if (forward) end = Math.min(source.length, end + (source.codePointAt(end)! > 0xffff ? 2 : 1));
    }
    for (const token of tokens(source, skillEnabled)) if (start < token.end && end > token.start) { start = Math.min(start, token.start); end = Math.max(end, token.end); }
    commit(source.slice(0, start) + text + source.slice(end), start + text.length, previousCaret);
  };
  const undo = (redo: boolean) => {
    const from = redo ? future.current : history.current; const to = redo ? history.current : future.current; const state = from.pop(); if (!state) return;
    to.push({ value: api.value, caret: api.selectionStart }); current.current = state.value;
    render(root.current!, state.value, skillEnabled, openFile); select(root.current!, state.caret, state.caret); onChange(state.value, state.caret);
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
    onSelect={onSelect} onKeyUp={onSelect} onScroll={onScroll} onBlur={onBlur} onDragOver={onDragOver} onDrop={onDrop}
    onBeforeInput={event => {
      if (disabled) { event.preventDefault(); return; }
      const type = (event.nativeEvent as InputEvent).inputType; if (composing.current) return;
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
    onPaste={event => { event.preventDefault(); if (!disabled) replace(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')); }}
    onCopy={event => { const [start, end] = selection(root.current!); if (start !== end) { event.preventDefault(); event.clipboardData.setData('text/plain', api.value.slice(start, end)); } }}
    onCut={event => { const [start, end] = selection(root.current!); if (start !== end) { event.preventDefault(); event.clipboardData.setData('text/plain', api.value.slice(start, end)); if (!disabled) replace(''); } }}
  />;
}
