/** Supported stable versions >= the minimum; tested revisions are recorded separately. */
export const OPENCODE_MINIMUM_VERSION = '2.0.0';

/** Kept self-contained apart from the minimum constant so the private SDK worker uses the same check. */
export function isSupportedOpenCodeVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number), minimum = OPENCODE_MINIMUM_VERSION.split('.').map(Number);
  return parts.every(Number.isSafeInteger) && (parts[0]! > minimum[0]! || parts[0] === minimum[0]
    && (parts[1]! > minimum[1]! || parts[1] === minimum[1] && parts[2]! >= minimum[2]!));
}
