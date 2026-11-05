import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenResponses } from '@ai-sdk/open-responses';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { APICallError, StreamProviderError, UnsupportedFunctionalityError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { FrozenBuiltinAgentConnection } from '@openworkgraph/protocol';
import { AgentError } from '../errors.js';
import type { BuiltinAgentConnections } from './connections.js';
import { BUILTIN_AGENT_LIMITS } from './limits.js';
import { builtinModelResponse, type BuiltinTransportOptions } from './transport.js';
import { deepSeekRequest, deepSeekResponse, isBuiltinDeepSeek } from './deepseek.js';
import { builtinMediaKind, builtinResponsesMedia } from './media.js';

/** Providers are per frozen attempt. The actual key is resolved only while
 * dispatching HTTP under the private credential lease, never through env. */
export function builtinLanguageModel(connections: BuiltinAgentConnections, reference: FrozenBuiltinAgentConnection, signal: AbortSignal, transport: BuiltinTransportOptions = {}): LanguageModel {
  const frozen = connections.frozen(reference);
  const deepseek = isBuiltinDeepSeek(frozen.configuration.endpoint);
  const media = frozen.model.inputKinds?.some(kind => kind === 'video' || kind === 'audio') ?? false;
  const expected = frozen.configuration.endpoint + (frozen.configuration.protocol === 'responses' ? '/responses' : '/chat/completions');
  const settings = {
    apiKey: 'builtin-private-auth-channel', baseURL: frozen.configuration.endpoint,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      signal.throwIfAborted();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== expected || init?.method !== 'POST' || typeof init.body !== 'string') throw new AgentError('invalid_configuration');
      if (Buffer.byteLength(init.body) > BUILTIN_AGENT_LIMITS.inputBytes) throw new AgentError('input_size_limit');
      let body = deepseek ? JSON.stringify(deepSeekRequest(JSON.parse(init.body), frozen.configuration.protocol)) : init.body;
      if (media && frozen.configuration.protocol === 'responses') body = JSON.stringify(builtinResponsesMedia(JSON.parse(body)));
      if (Buffer.byteLength(body) > BUILTIN_AGENT_LIMITS.inputBytes) throw new AgentError('input_size_limit');
      const response = await builtinModelResponse(async bounded => {
        const { value } = await connections.dispatch(reference, (_configuration, _model, key) => {
          bounded.throwIfAborted();
          const headers = new Headers(init.headers); headers.set('Authorization', 'Bearer ' + key);
          return fetch(url, { ...init, body, headers, signal: bounded, redirect: 'error' });
        });
        return value;
      }, AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]), transport);
      return deepseek && frozen.configuration.protocol === 'responses' ? deepSeekResponse(response) : response;
    },
  };
  if (frozen.configuration.protocol === 'responses') {
    if (deepseek || media) return createOpenResponses({ ...settings, name: 'openai', url: expected })(reference.modelId);
    return wrapLanguageModel({ model: createOpenAI(settings).responses(reference.modelId), middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        // Explicitly constrain automatic selection to this call's host tools.
        // Preserve narrower caller choices; response validation remains required.
        const mode = params.toolChoice?.type ?? 'auto';
        if (!params.tools?.length || (mode !== 'auto' && mode !== 'required')
          || params.providerOptions?.openai?.allowedTools !== undefined
          || params.tools.some(tool => tool.type !== 'function')) return params;
        return { ...params, providerOptions: { ...params.providerOptions, openai: {
          ...params.providerOptions?.openai,
          allowedTools: { toolNames: params.tools.map(tool => tool.name), mode },
        } } };
      },
    } });
  }
  // Compatible providers preserve reasoning_content without guessing which
  // vendor a proxy serves. OpenAI proxies can explicitly retain its catalog
  // rules (developer messages, max_completion_tokens, reasoning parameters).
  const chatProvider = frozen.configuration.chatProvider ?? (new URL(frozen.configuration.endpoint).origin === 'https://api.openai.com' ? 'openai' : 'openai-compatible');
  const base = chatProvider === 'openai' ? createOpenAI(settings).chat(reference.modelId)
    : createOpenAICompatible({ ...settings, name: 'openai', includeUsage: true }).chatModel(reference.modelId);
  if (media && chatProvider === 'openai-compatible') {
    // This SDK supplies native video/audio Chat serialization and reasoning
    // round trips. It still POSTs to the exact frozen Chat endpoint above.
    const native = createOpenRouter({ ...settings, compatibility: 'strict' }).chat(reference.modelId);
    type Params = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];
    const containsMedia = (params: Params) => params.prompt.some(message => message.role === 'user' && message.content.some(part => part.type === 'file' && builtinMediaKind(part.mediaType)));
    const nativeParams = (params: Params): Params => {
      const { reasoningEffort, ...options } = params.providerOptions?.openai ?? {};
      return { ...params, providerOptions: { ...params.providerOptions, openrouter: { ...options, ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }), ...params.providerOptions?.openrouter } } };
    };
    return wrapLanguageModel({ model: base, middleware: {
      specificationVersion: 'v4',
      wrapGenerate: ({ params, doGenerate }) => containsMedia(params) ? native.doGenerate(nativeParams(params)) : doGenerate(),
      wrapStream: ({ params, doStream }) => containsMedia(params) ? native.doStream(nativeParams(params)) : doStream(),
    } });
  }
  return base;
}

export function builtinModelFailure(error: unknown, depth = 0): AgentError {
  if (depth > 5) return new AgentError('protocol_error');
  if (error instanceof AgentError) return new AgentError(error.reason);
  if (UnsupportedFunctionalityError.isInstance(error)) return new AgentError('capability_unsupported');
  if (APICallError.isInstance(error) || StreamProviderError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) return new AgentError('authentication_required');
    if (error.statusCode === 429) return new AgentError('quota_exceeded');
    if (error.statusCode === 413) return new AgentError('input_size_limit');
    // SDK-parsed provider codes only: never infer a context failure from an
    // arbitrary 400/message or expose raw request bodies/provider diagnostics.
    type ProviderData = { code?: unknown; type?: unknown; error?: ProviderData; response?: { error?: ProviderData } };
    const data = error.data as ProviderData | undefined;
    const details = [data, data?.error, data?.response?.error, ...(StreamProviderError.isInstance(error) ? [error] : [])];
    if (details.some(item => [item?.code, item?.type].some(code => code === 'context_length_exceeded' || code === 'context_window_exceeded' || code === 'max_context_length_exceeded'))) return new AgentError('context_limit');
  }
  if (error && typeof error === 'object') {
    const value = error as { statusCode?: number; name?: string; lastError?: unknown; cause?: unknown };
    if (value.lastError && value.lastError !== error) return builtinModelFailure(value.lastError, depth + 1);
    if (value.statusCode === 401 || value.statusCode === 403) return new AgentError('authentication_required');
    if (value.statusCode === 429) return new AgentError('quota_exceeded');
    if (value.name === 'TimeoutError') return new AgentError('timeout');
    if (value.cause && value.cause !== error) return builtinModelFailure(value.cause, depth + 1);
  }
  return new AgentError('protocol_error');
}
