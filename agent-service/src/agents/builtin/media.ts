import type { BuiltinAgentProtocol } from '@openworkgraph/protocol';
import { AgentError } from '../errors.js';

const video = new Set(['video/mp4', 'video/mpeg', 'video/webm', 'video/quicktime', 'video/mov']);
const audio = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/aiff']);
const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', webm: 'video/webm', mov: 'video/quicktime',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', aiff: 'audio/aiff', aif: 'audio/aiff' };
export const builtinProjectMediaMime = (path: string): string | undefined => mime[path.split('.').at(-1)?.toLowerCase() ?? ''];
export function builtinMediaKind(type: string): 'video' | 'audio' | undefined {
  return video.has(type) ? 'video' : audio.has(type) ? 'audio' : undefined;
}
export function builtinAssertMediaFormat(type: string, protocol: BuiltinAgentProtocol): void {
  if (!builtinMediaKind(type) || protocol === 'responses' && type.startsWith('audio/') && !['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(type)) throw new AgentError('capability_unsupported');
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Open Responses serializes these FileParts as input_file. Translate only
 * frozen inline audio/video into the documented native Responses content parts.
 * The SDK retains tools, history, usage and response parsing; no media is fetched. */
export function builtinResponsesMedia(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.input)) return { ...body, store: false };
  return { ...body, store: false, input: body.input.map(message => {
    if (!object(message) || message.role !== 'user' || !Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => {
      if (!object(part) || part.type !== 'input_file' || typeof part.file_data !== 'string') return part;
      const prefix = /^data:((?:audio|video)\/[^;]+);base64,/.exec(part.file_data);
      if (!prefix) return part;
      const type = prefix[1]!; builtinAssertMediaFormat(type, 'responses');
      if (type.startsWith('video/')) return { type: 'input_video', video_url: part.file_data };
      return { type: 'input_audio', input_audio: { data: part.file_data.slice(prefix[0].length), format: type === 'audio/wav' || type === 'audio/x-wav' ? 'wav' : 'mp3' } };
    }) };
  }) };
}
