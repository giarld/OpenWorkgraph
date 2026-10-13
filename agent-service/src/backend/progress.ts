/** Fail closed for path/credential-bearing messages. Never pass tool output or reason here.
 * Inspect the whole message before bounding it; partial deltas are not safe to publish. */
export function publicProgressText(value: unknown): string {
  if (typeof value !== 'string' || /(?:[a-z]:[\\/]|\\\\|(?:^|[^a-z0-9._/\-])(?:\/|~[\\/])|file:\/\/|\.(?:env|ssh|codex|aws)\b|(?:api[_-]?key|access[_-]?token|password|secret|authorization|bearer|private[_ -]?key)\b|sk-[a-z0-9]{8})/im.test(value)) return '';
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 4000);
}
