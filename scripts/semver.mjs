const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Validate the full SemVer 2.0.0 syntax without normalizing the input. */
export function isValidSemVer(value) {
  if (typeof value !== 'string') return false;
  const match = SEMVER_PATTERN.exec(value);
  if (!match || match[0] !== value) return false;
  const prerelease = match[4];
  return prerelease === undefined || prerelease.split('.').every(identifier =>
    !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0')
  );
}
