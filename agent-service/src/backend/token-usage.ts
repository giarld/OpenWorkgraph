import type { TokenUsage } from '@openworkgraph/protocol';

export function tokenUsage(input: unknown, output: unknown): TokenUsage | undefined {
  return Number.isSafeInteger(input) && Number(input) >= 0 && Number.isSafeInteger(output) && Number(output) >= 0
    ? { input: Number(input), output: Number(output) } : undefined;
}

export function sumTokens(...values: unknown[]): number | undefined {
  if (values.some(value => !Number.isSafeInteger(value) || Number(value) < 0)) return undefined;
  const sum = values.reduce<number>((sum, value) => sum + Number(value), 0);
  return Number.isSafeInteger(sum) ? sum : undefined;
}
