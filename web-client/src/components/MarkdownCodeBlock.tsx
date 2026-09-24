import { Children, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-yaml';
import type { Components } from 'react-markdown';
import { useI18n } from '../i18n/I18nProvider';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; [key: string]: unknown };

/** Preserve single LF characters as visible Markdown line breaks without touching code nodes. */
function remarkLfBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      parent.children = parent.children.flatMap(child => {
        if (child.type !== 'text' || !child.value?.includes('\n')) {
          visit(child);
          return [child];
        }
        const values = child.value.split('\n');
        return values.flatMap((value, index) => [
          ...(value ? [{ ...child, value }] : []),
          ...(index < values.length - 1 ? [{ type: 'break' }] : []),
        ]);
      });
    };
    visit(tree);
  };
}

const languageNames: Record<string, string> = {
  bash: 'Shell', c: 'C', cpp: 'C++', csharp: 'C#', css: 'CSS', go: 'Go', html: 'HTML',
  java: 'Java', javascript: 'JavaScript', js: 'JavaScript', json: 'JSON', jsx: 'JSX',
  diff: 'Diff', patch: 'Diff',
  markdown: 'Markdown', md: 'Markdown', plaintext: 'Plain text', python: 'Python', py: 'Python',
  rust: 'Rust', shell: 'Shell', sql: 'SQL', ts: 'TypeScript', tsx: 'TSX',
  typescript: 'TypeScript', xml: 'XML', yaml: 'YAML', yml: 'YAML',
};

const grammarLanguages: Record<string, string> = {
  html: 'markup', md: 'markdown', patch: 'diff', py: 'python', shell: 'bash', ts: 'typescript', xml: 'markup', yml: 'yaml',
};

type HighlightSegment = { text: string; classes: string[] };

function highlightedLines(value: string, language: string): HighlightSegment[][] {
  const grammar = Prism.languages[grammarLanguages[language] ?? language];
  if (!grammar || language === 'plaintext') return value.split('\n').map(text => text ? [{ text, classes: [] }] : []);

  const lines: HighlightSegment[][] = [[]];
  const append = (text: string, classes: string[]) => {
    text.split('\n').forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, classes });
    });
  };
  const visit = (content: string | Prism.Token | Array<string | Prism.Token>, classes: string[] = []) => {
    if (typeof content === 'string') return append(content, classes);
    if (Array.isArray(content)) return content.forEach(child => visit(child, classes));
    const aliases = typeof content.alias === 'string' ? [content.alias] : content.alias ?? [];
    visit(content.content, [...classes, 'token', content.type, ...aliases]);
  };
  visit(Prism.tokenize(value, grammar));
  return lines;
}

const nodeText = (value: ReactNode): string => Children.toArray(value).map(child =>
  typeof child === 'string' || typeof child === 'number'
    ? String(child)
    : isValidElement(child)
      ? nodeText((child.props as { children?: ReactNode }).children)
      : '',
).join('');

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  const code = Children.toArray(children).find(isValidElement) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const language = /(?:^|\s)language-([^\s]+)/.exec(code?.props.className ?? '')?.[1]?.toLowerCase() ?? 'plaintext';
  const value = nodeText(code?.props.children ?? children).replace(/\n$/, '').replace(/\r\n?/g, '\n');
  const lines = highlightedLines(value, language);
  const [copied, setCopied] = useState(false);
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(reset.current);
      reset.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const languageName = t(languageNames[language] ?? language);
  return <section className="markdown-code-editor" aria-label={t("{language} code block", { language: languageName })}>
    <header className="markdown-code-toolbar">
      <span className="markdown-code-lights" aria-hidden="true"><i/><i/><i/></span>
      <span className="markdown-code-language">{languageName}</span>
      <button type="button" className="markdown-code-copy" aria-label={copied ? t('Code copied') : t('Copy code')} onClick={copy}>
        {copied ? <Check size={14}/> : <Copy size={14}/>}<span>{copied ? t('Copied') : t('Copy')}</span>
      </button>
    </header>
    <div className="markdown-code-viewport">
      <pre className="markdown-code-source"><code className={code?.props.className} aria-label={value}>{lines.map((line, index) => <span className="markdown-code-line" key={index}>
        <span className="markdown-code-gutter" aria-hidden="true">{index + 1}</span>
        <span className="markdown-code-text">{line.length ? line.map((segment, segmentIndex) => segment.classes.length
          ? <span className={segment.classes.join(' ')} key={segmentIndex}>{segment.text}</span>
          : segment.text) : '\u00a0'}</span>
      </span>)}</code></pre>
    </div>
  </section>;
}

export const markdownCodeComponents: Components = { pre: MarkdownCodeBlock };
export const markdownRemarkPlugins = [remarkLfBreaks];
