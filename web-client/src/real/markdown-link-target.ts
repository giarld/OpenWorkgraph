export type MarkdownLinkTarget =
  | { kind: 'anchor'; href: string }
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'invalid' };

export function markdownLinkTarget(href: string): MarkdownLinkTarget {
  const value = href.trim();
  if (!value) return { kind: 'invalid' };
  if (value.startsWith('#')) return { kind: 'anchor', href: value };
  if (value.startsWith('//')) return { kind: 'external', url: 'https:' + value };
  if (/^https?:[/][/]/i.test(value)) {
    try { return { kind: 'external', url: new URL(value).href }; }
    catch { return { kind: 'invalid' }; }
  }
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'file:' ? { kind:'file', path:url.href } : { kind:'invalid' };
    } catch { return { kind:'invalid' }; }
  }
  if (/^[a-z]:/i.test(value) && (value[2] === '/' || value.charCodeAt(2) === 92)) {
    const suffix = Math.min(...[value.indexOf('?'), value.indexOf('#')].filter(index => index >= 0), value.length);
    try { return { kind:'file', path:decodeURIComponent(value.slice(0, suffix)) }; }
    catch { return { kind:'invalid' }; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: 'invalid' };

  const suffix = Math.min(...[value.indexOf('?'), value.indexOf('#')].filter(index => index >= 0), value.length);
  let path: string;
  try { path = decodeURIComponent(value.slice(0, suffix)).replaceAll('\\', '/'); }
  catch { return { kind: 'invalid' }; }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return { kind: 'invalid' };
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) return { kind:'invalid' };
  return { kind:'file', path:(path.startsWith('/') ? '/' : '') + parts.join('/') };
}
