/** Presentation metadata is independent of node content and execution inputs. */
export const NODE_BORDER_COLORS = [
  { name: 'Red', value: '#d96771' },
  { name: 'Orange', value: '#dd8a52' },
  { name: 'Gold', value: '#bd9e3c' },
  { name: 'Lime', value: '#8da84e' },
  { name: 'Green', value: '#4eaa79' },
  { name: 'Teal', value: '#419e9b' },
  { name: 'Cyan', value: '#4ba5c9' },
  { name: 'Blue', value: '#5888d5' },
  { name: 'Indigo', value: '#8174cc' },
  { name: 'Violet', value: '#ad70bf' },
] as const;

export function isNodeBorderColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
