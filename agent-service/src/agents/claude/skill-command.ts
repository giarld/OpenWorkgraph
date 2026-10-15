import type { Json, AgentPlatform } from '@openworkgraph/protocol';
import type { BackendRunContext } from '../../backend/types.js';
import { AgentError } from '../errors.js';
import { ClaudeTransport } from './transport.js';
import { claudeResponse, type ClaudeSend } from './interactions.js';
import { launchClaude, signalClaude, claudeGroupAlive, type ClaudeDeviceOptions } from './process.js';
import { redactClaudeOutput } from './output.js';

/** Protected command configuration is scoped to a native Claude session, not
 * written into a prompt/tool argument or dispatched by a host shell. SDK hooks
 * admit exactly the frozen argv and return actual native tool output. */
export function nativeSkillCommand(options: ClaudeDeviceOptions, context: BackendRunContext, argv: string[], environment: Record<string, string>, secrets: Record<string, string>, signal: AbortSignal, permission: (message: Record<string, any>, send: ClaudeSend) => Promise<void>, onClosed: (known: boolean) => void, platform: AgentPlatform = process.platform as AgentPlatform, withdrawn?: (id: string | null) => Promise<void>): Promise<Json> {
  signal.throwIfAborted();
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const tool = platform === 'win32' ? 'PowerShell' : 'Bash';
  const command = platform === 'win32' ? '& ' + argv.map(value => "'" + value.replaceAll("'", "''") + "'").join(' ') : argv.map(quote).join(' ');
  const mode = context.agent?.options.sandboxMode;
  const args = ['--print', '--verbose', '--include-hook-events', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--tools', tool, '--disable-slash-commands', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', mode === 'danger-full-access' ? 'bypassPermissions' : 'default', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', '--settings', JSON.stringify({ sandbox: { enabled: false }, disableAllHooks: true, permissions: { deny: mode === 'read-only' ? [tool] : [] } }), '--model', context.model.model, '--max-turns', '3'];
  if (context.model.reasoningEffort) args.push('--effort', context.model.reasoningEffort);
  const child = launchClaude(options, args, context.projectPath, { ...process.env, ...environment, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' });
  let captured: Json | undefined, used = false, wireFailed = false;
  let toolUseId: string | null | undefined;
  const abort = () => { signalClaude(child, 'SIGTERM'); killTimer = setTimeout(() => signalClaude(child, 'SIGKILL'), options.stopTimeoutMs ?? 2000); killTimer.unref(); };
  let killTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => { wireFailed = true; signalClaude(child, 'SIGKILL'); }, Math.min(options.runTimeoutMs ?? 120000, 120000)); timer.unref();
  signal.addEventListener('abort', abort, { once: true });
  const transport: ClaudeTransport = new ClaudeTransport(child, event => {
    if (event.type === 'result') transport.end();
    if (event.type === 'control_cancel_request' && typeof event.request_id === 'string') void withdrawn?.(event.request_id).catch(() => { wireFailed = true; signalClaude(child, 'SIGKILL'); });
  }, async message => {
    const request = message.request;
    if (request?.subtype === 'can_use_tool') {
      if (request.tool_name !== tool || request.input?.command !== command) { await transport.send(claudeResponse(message.request_id, { behavior: 'deny', message: 'Only the frozen skill command is available.' })); return; }
      await permission(message, value => transport.send(value)); return;
    }
    if (request?.subtype !== 'hook_callback' || request.input?.tool_name !== tool) throw new AgentError('protocol_error');
    const input = request.input;
    let response: Record<string, unknown> = {};
    if (request.callback_id === 'skill-pre') {
      const allowed = !used;
      if (allowed) { used = true; toolUseId = request.tool_use_id; }
      // Pin the actual native tool input. Equivalent model-generated quoting
      // must not change argv or cause repeated inference/permission retries.
      response = { hookSpecificOutput: { hookEventName: 'PreToolUse', ...(allowed ? { updatedInput: { ...input.tool_input, command, run_in_background: false } } : { permissionDecision: 'deny', permissionDecisionReason: 'Only one invocation of the frozen command is allowed.' }) } };
    } else if (request.callback_id === 'skill-post' || request.callback_id === 'skill-failed') {
      if (!used || request.tool_use_id !== toolUseId || captured !== undefined) throw new AgentError('protocol_error');
      const cleaned = redactClaudeOutput(input.tool_response ?? { error: input.error ?? 'Native command failed' }, secrets);
      const safe = JSON.stringify(cleaned);
      if (Buffer.byteLength(safe) > 16000) captured = { status: 'failed', code: 'OUTPUT_TOO_LARGE' };
      else captured = { status: request.callback_id === 'skill-post' ? 'completed' : 'failed', output: cleaned };
      response = request.callback_id === 'skill-post' ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: cleaned } } : { continue: false, stopReason: 'Native skill command failed.' };
    } else throw new AgentError('protocol_error');
    await transport.send(claudeResponse(message.request_id, response));
  }, () => { wireFailed = true; signalClaude(child, 'SIGKILL'); });
  const work = (async () => {
    await transport.request({ subtype: 'initialize', hooks: { PreToolUse: [{ matcher: tool, hookCallbackIds: ['skill-pre'] }], PostToolUse: [{ matcher: tool, hookCallbackIds: ['skill-post'] }], PostToolUseFailure: [{ matcher: tool, hookCallbackIds: ['skill-failed'] }] }, skills: [] }, options.queryTimeoutMs ?? 20000);
    await transport.send({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Execute exactly this ' + tool + ' command once, with run_in_background=false. Do not read configuration, add commands or change it. Return a brief completion message afterwards. Command: ' + command } });
  })();
  void work.catch(() => { wireFailed = true; signalClaude(child, 'SIGKILL'); });
  return transport.closed.then(async closed => {
    clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort); await work.catch(() => {});
    const known = !claudeGroupAlive(child) && !closed.failed && !wireFailed;
    await withdrawn?.(null);
    if (!known) { signalClaude(child, 'SIGKILL'); onClosed(false); throw new AgentError('outcome_unknown'); }
    onClosed(true);
    if (signal.aborted) throw new AgentError('outcome_unknown');
    // The operation is the native command, not the worker's later prose. A
    // confirmed PostToolUse/Failure plus a drained process is the result even
    // when a redundant follow-up exhausts the worker's inference turn budget.
    if (captured === undefined) return { status: 'failed', code: 'NATIVE_COMMAND_FAILED' };
    return captured;
  });
}
