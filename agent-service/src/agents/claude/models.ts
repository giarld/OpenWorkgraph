import type { AgentModelOption } from '@openworkgraph/protocol';
import type { AgentQueryContext } from '../contracts.js';
import { AgentError } from '../errors.js';
import { ClaudeJsonLines } from './jsonl.js';
import { claudeVersion, launchClaude, signalClaude, claudeGroupAlive, drainClaude, type ClaudeDeviceOptions } from './process.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Native initialization advertises the device's stable model/effort order.
 * No user message is sent and no inference occurs. Queries never load project hooks/MCP. */
export async function claudeModels(options: ClaudeDeviceOptions, context: AgentQueryContext): Promise<AgentModelOption[]> {
  await claudeVersion(options, context); context.signal.throwIfAborted();
  const args = ['--print', '--verbose', '--include-hook-events', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--restricted', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--tools', '', '--disable-slash-commands'];
  let child: ChildProcessWithoutNullStreams | undefined; let closed: Promise<void> | undefined;
  const abort = () => { if (child) signalClaude(child, 'SIGKILL'); };
  context.deferCleanup(async () => { context.signal.removeEventListener('abort', abort); await drainClaude(child, closed, options.stopTimeoutMs); });
  context.signal.addEventListener('abort', abort, { once: true });
  context.signal.throwIfAborted();
  child = launchClaude(options, args, context.projectPath ?? process.cwd());
  const native = child; closed = new Promise<void>(resolve => native.once('close', () => resolve()));
  return await new Promise<AgentModelOption[]>((resolve, reject) => {
    let catalog: AgentModelOption[] | undefined; let failed = false; const hooks = new Set<string>();
    const fail = (reason: 'protocol_error' | 'runtime_unavailable' | 'timeout') => { failed = true; clearTimeout(timer); abort(); reject(new AgentError(reason)); };
    const timer = setTimeout(() => fail('timeout'), options.queryTimeoutMs ?? 5000);
    const parser = new ClaudeJsonLines(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const event = raw as Record<string, any>;
      if (event.type === 'system' && /^(?:hook|task)_/.test(String(event.subtype))) {
        const id = event.hook_id;
        if (typeof id !== 'string' || !id || id.length > 256) { fail('protocol_error'); return; }
        if (event.subtype === 'hook_started' && !hooks.has(id) && hooks.size < 256) hooks.add(id);
        else if (event.subtype === 'hook_progress' && hooks.has(id)) { /* private output */ }
        else if (event.subtype === 'hook_response' && hooks.has(id) && event.outcome === 'success') hooks.delete(id);
        else fail('protocol_error');
        return;
      }
      if (event.type !== 'control_response' || event.response?.request_id !== 'workgraph-models') return;
      if (catalog || event.response.subtype !== 'success' || !Array.isArray(event.response.response?.models)) { fail('protocol_error'); return; }
      const models = event.response.response.models;
      if (models.length > 256) { fail('protocol_error'); return; }
      try {
        catalog = models.map((model: any) => {
          if (!model || typeof model.value !== 'string' || !model.value.trim() || model.value.length > 256 || /[\u0000-\u001f\u007f]/.test(model.value)) throw new Error();
          const efforts = model.supportsEffort === true ? model.supportedEffortLevels : [];
          if (!Array.isArray(efforts) || efforts.length > 16 || efforts.some((effort: unknown) => typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(effort)) || new Set(efforts).size !== efforts.length) throw new Error();
          // The CLI advertises low-to-high strength order, preserved verbatim.
          return { id: model.value, reasoningEfforts: [...efforts], defaultReasoningEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? null };
        });
        if (new Set(catalog!.map(model => model.id)).size !== catalog!.length) throw new Error();
      } catch { fail('protocol_error'); return; }
      native.stdin.end();
    });
    let stderrBytes = 0;
    native.stdout.on('data', chunk => { try { parser.write(chunk); } catch { fail('protocol_error'); } });
    native.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) fail('protocol_error'); });
    native.stdin.on('error', () => fail('protocol_error'));
    native.once('spawn', () => native.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'workgraph-models', request: { subtype: 'initialize', hooks: null } }) + String.fromCharCode(10)));
    native.once('error', () => fail('runtime_unavailable'));
    native.once('close', code => {
      clearTimeout(timer); try { parser.end(); } catch { failed = true; reject(new AgentError('protocol_error')); }
      if (failed) return;
      if (context.signal.aborted) { reject(context.signal.reason); return; }
      if (code !== 0 || !catalog || hooks.size || claudeGroupAlive(native)) { reject(new AgentError('protocol_error')); return; }
      resolve(catalog);
    });
  });
}
