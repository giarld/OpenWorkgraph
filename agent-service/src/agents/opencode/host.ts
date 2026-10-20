import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AgentHostTools } from '../host-tools.js';
import type { Json } from '@openworkgraph/protocol';
import { AgentError } from '../errors.js';

/** Private Run/attempt-scoped native tool endpoint. All business data checks
 * remain in AgentHostTools; native session membership is checked before calls. */
export class OpenCodeHost {
  private readonly token = randomBytes(32).toString('hex');
  private readonly server: Server;
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  private requests = 0;
  constructor(private readonly tools: AgentHostTools, private readonly owns: (session: string) => Promise<boolean>, private readonly command?: (id: string, args: unknown) => Promise<Json>) {
    this.server = createServer(async (request, response) => {
      const supplied = Buffer.from(request.headers.authorization ?? ''), wanted = Buffer.from('Bearer ' + this.token);
      if (!this.accepting || supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) { response.writeHead(403).end(); return; }
      if (request.method !== 'POST' || request.url !== '/native-tool') { response.writeHead(404).end(); return; }
      if (this.pending.size >= 16 || ++this.requests > 2048) { response.writeHead(429).end(); return; }
      const work = (async () => {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 32768) throw new AgentError('protocol_error'); chunks.push(Buffer.from(chunk)); }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!this.accepting || typeof body.callId !== 'string' || body.callId.length > 128 || typeof body.sessionId !== 'string' || !await this.owns(body.sessionId)) throw new AgentError('outcome_unknown');
        const result = body.name === 'run_skill_command' && this.command ? await this.command(body.callId, body.arguments)
          : await this.tools.call({ runId: this.tools.runId, attemptId: this.tools.attemptId, callId: body.callId, name: body.name, arguments: body.arguments });
        if (!this.accepting) throw new AgentError('outcome_unknown');
        if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new AgentError('protocol_error');
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
      })();
      this.pending.add(work);
      try { await work; } catch { if (!response.headersSent) response.writeHead(409); response.end(); }
      finally { this.pending.delete(work); }
    });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000; this.server.maxConnections = 32;
  }
  async listen() {
    await new Promise<void>((accept, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); accept(); }); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new AgentError('runtime_unavailable');
    return { url: 'http://127.0.0.1:' + address.port + '/native-tool', token: this.token, tools: [
      ...this.tools.describe(), ...(this.command ? [{ name: 'run_skill_command', description: 'Run exactly one frozen skill argv with native permissions and private per-call configuration.', inputSchema: { type: 'object', properties: { skillId: { type: 'string' }, command: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } } }, required: ['skillId', 'command'], additionalProperties: false } }] : []),
    ] };
  }
  async close(): Promise<void> { this.accepting = false; this.server.closeAllConnections(); await new Promise<void>(accept => this.server.close(() => accept())); await Promise.allSettled([...this.pending]); }
}
