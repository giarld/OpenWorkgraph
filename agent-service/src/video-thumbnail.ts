import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ServiceError } from './errors.js';

const execute = promisify(execFile);
let active = 0;
const waiting: (() => void)[] = [];

/** Bound decoder work across all workspaces; only small frames reach Node. */
export async function videoThumbnail(path: string, size: number): Promise<Buffer> {
 if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
 else active++;
 try {
  const { stdout } = await execute('ffmpeg', [
   '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', path,
   '-map', '0:v:0', '-frames:v', '1', '-vf',
   'scale=' + size + ':' + size + ':force_original_aspect_ratio=decrease',
   '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], { encoding:'buffer', timeout:10_000, maxBuffer:2 * 1024 * 1024, windowsHide:true });
  return await sharp(stdout).webp({quality:75}).toBuffer();
 } catch (cause) {
  throw new ServiceError('INVALID_REQUEST', '无法生成视频封面，请确认工作空间可使用 FFmpeg。', {cause});
 } finally {
  const next = waiting.shift();
  if (next) next();
  else active--;
 }
}
