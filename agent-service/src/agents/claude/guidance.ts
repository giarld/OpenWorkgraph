/** Claude-specific native input tools. Product node and delivery rules are imported separately. */
export function claudeNativeGuidance(): string {
  return 'Use native tools to read inputs and verify outputs. For PDF use Read; for Office/binary inputs use available native commands or installed converters. For video inspect actual frames and audio via installed native tools; do not infer content from filenames. Report unavailable decoders.';
}
