import type { ModelMessage } from 'ai';

/** Text for estimation/summary only. Original SDK FileParts remain untouched.
 * Never tokenize a data URL/base64 blob or expand typed arrays into JSON. Media
 * token costs are model-specific and are learned from SDK usage, not file size. */
export function builtinContextText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object') return item;
    if ('type' in item && ((item.type === 'file' || item.type === 'reasoning-file') && 'mediaType' in item && 'data' in item || item.type === 'image' && 'image' in item)) {
      const part = item as { type: string; mediaType?: string; filename?: string };
      return { type: part.type, mediaType: part.mediaType, filename: part.filename, content: '[media retained in original input]' };
    }
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || 'type' in item && item.type === 'Buffer' && 'data' in item) return '[binary content omitted]';
    return item;
  });
}

/** Scheduling heuristic, NOT an exact count or an admission check. No universal
 * tokenizer exists for arbitrary OpenAI-compatible models in the locked SDK. */
export const builtinEstimateTextTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3);
export const builtinEstimateMessageTokens = (messages: readonly ModelMessage[]): number => builtinEstimateTextTokens(builtinContextText(messages));

/** A JSON string can use six wire bytes per input byte (e.g. escaped controls).
 * Keep framing/system/provider options separate from the model-token estimate. */
export function builtinSummaryInputBytes(contextTokens: number, outputTokens: number, requestBytes: number): number {
  return Math.min(Math.floor((requestBytes - 65536) / 6), (contextTokens - outputTokens - 1024) * 3);
}

/** Anchor the next turn to native input usage (includes media and tool schemas),
 * estimating only text added since that request. Never publish these estimates
 * as usage. A new compacted representation invalidates the old anchor. */
export class BuiltinContextBudget {
  private observation: { inputTokens: number; estimatedTokens: number } | undefined;
  observe(inputTokens: number | undefined, estimatedTokens: number): void {
    if (typeof inputTokens === 'number' && Number.isSafeInteger(inputTokens) && inputTokens >= 0) this.observation = { inputTokens, estimatedTokens };
  }
  estimate(estimatedTokens: number): number {
    return this.observation ? Math.max(0, this.observation.inputTokens + estimatedTokens - this.observation.estimatedTokens) : estimatedTokens;
  }
  reset(): void { this.observation = undefined; }
}
