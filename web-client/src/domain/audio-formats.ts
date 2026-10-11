export const audioMimeByExtension: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav',
  m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
};

/** Prefer a known extension when uploads retain a generic or incorrect MIME. */
export function previewAudioMime(name: string, mime = ''): string | undefined {
  const extension = name.includes('.') ? name.split('.').at(-1)?.toLowerCase() ?? '' : '';
  if (Object.hasOwn(audioMimeByExtension, extension)) return audioMimeByExtension[extension];
  const normalized = mime.split(';')[0].trim().toLowerCase();
  return normalized.startsWith('audio/') ? normalized : undefined;
}
