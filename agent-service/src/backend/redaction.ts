/** Finite literal redaction. Callers pass only schema-declared secrets. */
export function redactSkillValues(value: string, environment: Record<string,string>): string {
  // Finite literal forms: raw values and at most two JSON.stringify string-body
  // escape layers. This does not cover arbitrary encodings or fragmented output.
  const forms = new Set<string>();
  for (const secret of new Set(Object.values(environment))) {
    if (!secret) continue;
    let form = secret;
    forms.add(form);
    for (let depth = 0; depth < 2; depth++) {
      form = JSON.stringify(form).slice(1, -1);
      forms.add(form);
    }
  }
  if (!forms.size) return value;
  // Match once against the original text. Longest first handles overlapping
  // values; the marker prevents repeated snapshots from redacting it again.
  forms.add('[redacted]');
  const pattern = [...forms].sort((a,b) => b.length-a.length).map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return value.replace(new RegExp(pattern, 'g'), '[redacted]');
}
