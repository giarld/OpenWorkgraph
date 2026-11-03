import { AgentError } from '../errors.js';

/** Unauthenticated retrieval only. Returned page text is untrusted input, not
 * host instructions. No browser, JavaScript execution, or search provider. */
export async function readBuiltinUrl(value: string, signal: AbortSignal, offset = 0, length = 12000): Promise<{ url: string; contentType: string; untrusted: true; content: string; offset: number; nextOffset: number | null; totalCharacters: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 16000) throw new AgentError('invalid_configuration');
  let url: URL;
  try { url = new URL(value); } catch { throw new AgentError('invalid_configuration'); }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      bounded.throwIfAborted();
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) throw new AgentError('invalid_configuration');
      const response = await fetch(url, { signal: bounded, redirect: 'manual', headers: { Accept: 'text/html,text/plain,application/json,application/xhtml+xml' }, credentials: 'omit' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || redirects === 5) throw new AgentError('protocol_error');
        const next = new URL(location, url);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new AgentError('permission_denied');
        url = next; continue;
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase();
      if (!response.ok || !response.body || !['text/html', 'text/plain', 'application/json', 'application/xhtml+xml', 'text/markdown'].includes(type)) { await response.body?.cancel(); throw new AgentError('capability_unsupported'); }
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 512 * 1024) throw new AgentError('invalid_configuration'); parts.push(chunk.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const content = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(parts));
      if (offset > content.length) throw new AgentError('invalid_configuration');
      let end = Math.min(offset + length, content.length);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
      if (end === offset && end < content.length) end = Math.min(offset + 2, content.length);
      return { url: url.href, contentType: type, untrusted: true, content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalCharacters: content.length };
    }
    throw new AgentError('protocol_error');
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (bounded.aborted) throw new AgentError('timeout');
    if (error instanceof AgentError) throw error;
    throw new AgentError('protocol_error');
  }
}
