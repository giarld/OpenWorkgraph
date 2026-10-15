import { TextDecoder } from 'node:util';
import { AgentError } from '../errors.js';

/** Bound wire bytes before decoding. Unknown JSON events are handled by the adapter. */
export class ClaudeJsonLines {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private bytes = 0;
  private lines = 0;
  private ended = false;
  constructor(private readonly receive: (event: unknown) => void, private readonly maxBytes = 2 * 1024 * 1024) {}
  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.ended || this.bytes > this.maxBytes * 16) throw new AgentError('protocol_error');
    let text: string;
    try { text = this.decoder.decode(chunk, { stream: true }); } catch { throw new AgentError('protocol_error'); }
    this.consume(text);
  }
  end(): void {
    if (this.ended) return; this.ended = true;
    let text: string;
    try { text = this.decoder.decode(); } catch { throw new AgentError('protocol_error'); }
    this.consume(text); if (this.pending.trim()) this.line(this.pending); this.pending = '';
  }
  private consume(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf(String.fromCharCode(10))) !== -1) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1); this.line(line);
    }
    if (Buffer.byteLength(this.pending) > this.maxBytes) throw new AgentError('protocol_error');
  }
  private line(line: string): void {
    if (Buffer.byteLength(line) > this.maxBytes) throw new AgentError('protocol_error');
    if (!line.trim()) { this.countLine(); return; }
    let value: unknown; try { value = JSON.parse(line); } catch { throw new AgentError('protocol_error'); }
    // Recent native CLIs emit one thinking_tokens notification per thinking
    // update. They contain no actionable lifecycle event and must not exhaust
    // the message budget before the final result. Byte/frame bounds still apply.
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'system' &&
      (value as Record<string, unknown>).subtype === 'thinking_tokens') return;
    this.countLine();
    this.receive(value);
  }
  private countLine(): void { if (++this.lines > 8192) throw new AgentError('protocol_error'); }
}
