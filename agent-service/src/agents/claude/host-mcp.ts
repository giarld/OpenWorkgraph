import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SERVICE_VERSION } from '@openworkgraph/protocol';
import type { AgentHostTools, AgentHostTool } from '../host-tools.js';
import type { Json } from '@openworkgraph/protocol';

/** A private stateless HTTP MCP endpoint, scoped to exactly one Run/attempt. */
export class ClaudeHostMcp {
  private readonly server: Server;
  private readonly token = randomBytes(32).toString('hex');
  private readonly commandNamespace = randomBytes(12).toString('hex');
  private accepting = true;
  private serial = 0;
  private requests = 0;
  private pendingRequests = 0;
  private closing?: Promise<void>;
  private readonly calls = new Set<Promise<unknown>>();
  constructor(private readonly tools: AgentHostTools, private readonly command?: { describe: AgentHostTool; call: (callId: string, args: unknown) => Promise<Json> }) {
    this.server = createServer((req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? ''); const wanted = Buffer.from('Bearer ' + this.token);
      if (!this.accepting || auth.length !== wanted.length || !timingSafeEqual(auth, wanted)) { res.writeHead(403).end(); return; }
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405).end(); return; }
      if (this.pendingRequests >= 16 || ++this.requests > 1024) { res.writeHead(429).end(); return; }
      this.pendingRequests++;
      let dispatched = false, released = false;
      const release = () => { if (!released) { released = true; this.pendingRequests--; } };
      req.on('error', () => { if (!dispatched) release(); });
      res.on('close', () => { if (!dispatched) release(); });
      let body = ''; let bytes = 0;
      req.setEncoding('utf8');
      req.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 32768) { res.writeHead(413).end(); req.destroy(); } else body += chunk; });
      req.on('end', () => {
        if (res.writableEnded || res.destroyed) return;
        if (!this.accepting) { res.writeHead(403).end(); return; }
        dispatched = true;
        const work = this.dispatch(body).then(result => { if (!res.destroyed) { if (result === null) res.writeHead(202).end(); else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result)); } }).catch(() => { if (!res.destroyed) res.writeHead(400).end(); });
        this.calls.add(work); void work.finally(() => { this.calls.delete(work); release(); });
      });
    });
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000;
    this.server.maxConnections = 32;
  }
  async listen(): Promise<Record<string, unknown>> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); }); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('MCP unavailable');
    return { mcpServers: { workgraph: { type: 'http', url: 'http://127.0.0.1:' + address.port + '/mcp', headers: { Authorization: 'Bearer ' + this.token } } } };
  }
  private async dispatch(body: string): Promise<unknown> {
    if (!this.accepting) throw new Error('MCP closed');
    const message = JSON.parse(body);
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid MCP request');
    if (message.id === undefined) return null;
    if (!(typeof message.id === 'string' || typeof message.id === 'number')) throw new Error('Invalid MCP id');
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'openworkgraph', version: SERVICE_VERSION } });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: [...this.tools.describe(), ...(this.command ? [this.command.describe] : [])].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (message.method === 'tools/call') {
      if (typeof message.params?.name !== 'string') throw new Error('Invalid MCP tool');
      if (message.params.name === 'run_skill_command' && this.command) {
        try { const value = await this.command.call('mcp-command-' + this.commandNamespace + ':' + String(message.id), message.params.arguments); return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: !!value && typeof value === 'object' && !Array.isArray(value) && value.status === 'failed' }); }
        catch { return reply({ content: [{ type: 'text', text: 'Native skill command failed' }], isError: true }); }
      }
      if (!this.tools.describe().some(tool => tool.name === message.params.name)) return reply({ content: [{ type: 'text', text: 'Host tool capability is not available' }], isError: true });
      const result = await this.tools.call({ runId: this.tools.runId, attemptId: this.tools.attemptId, callId: 'mcp-' + (++this.serial), name: message.params.name, arguments: message.params.arguments ?? {} });
      return reply({ content: [{ type: 'text', text: result.content }], isError: !result.success });
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }
  async close(): Promise<void> {
    this.accepting = false; this.server.closeAllConnections();
    this.closing ??= (async () => {
      await new Promise<void>(resolve => this.server.close(() => resolve()));
      await Promise.allSettled([...this.calls]);
    })();
    await this.closing;
  }
}
