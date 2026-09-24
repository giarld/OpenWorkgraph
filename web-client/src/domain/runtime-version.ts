interface ParsedSemVer {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemVer(version: string): ParsedSemVer | undefined {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return undefined;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length || !right.length) return left.length === right.length ? 0 : left.length ? -1 : 1;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index], b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return compareNumericIdentifier(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Invalid version data does not produce an upgrade warning. */
export function runtimeNeedsUpgrade(runtimeVersion: string, clientVersion: string): boolean {
  const runtime = parseSemVer(runtimeVersion), client = parseSemVer(clientVersion);
  if (!runtime || !client) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = compareNumericIdentifier(runtime[key], client[key]);
    if (difference) return difference < 0;
  }
  return comparePrerelease(runtime.prerelease, client.prerelease) < 0;
}
