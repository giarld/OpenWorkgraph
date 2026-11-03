import { deepSeekOutputTokens, isBuiltinDeepSeek } from './deepseek.js';
/** Product ceilings, never model-controlled arguments. */
export const BUILTIN_AGENT_LIMITS = Object.freeze({
  modelRequests: 64, toolCalls: 256, activeMs: 30 * 60 * 1000, wallMs: 12 * 60 * 60 * 1000,
  requestMs: 120000, requestWallMs: 15 * 60 * 1000, toolMs: 120000, commandMs: 10 * 60 * 1000, drainMs: 1000, toolResultBytes: 65536, answerBytes: 1024 * 1024,
  historyBytes: 16 * 1024 * 1024, inputBytes: 8 * 1024 * 1024, outputTokens: 8192, reasoningOutputTokens: 32768, maxOutputTokens: 393216,
});

/** Reasoning consumes the same generation allowance as visible text/tool arguments.
 * No model-name inference; explicit connection settings can retain smaller caps. */
export function builtinOutputTokens(model: { contextWindow: number | null; maxOutputTokens?: number | null }, reasoningEffort: string | null, endpoint = ''): number {
  const requested = model.maxOutputTokens ?? (isBuiltinDeepSeek(endpoint) ? deepSeekOutputTokens(reasoningEffort) : reasoningEffort && reasoningEffort !== 'none' ? BUILTIN_AGENT_LIMITS.reasoningOutputTokens : BUILTIN_AGENT_LIMITS.outputTokens);
  return Math.min(BUILTIN_AGENT_LIMITS.maxOutputTokens, requested, Math.max(1024, (model.contextWindow ?? 0) - 4096));
}
