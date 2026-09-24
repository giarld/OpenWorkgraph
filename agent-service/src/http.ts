import type { IncomingMessage } from 'node:http';
import { ServiceError } from './errors.js';
export function readJson(request: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  if (!/^application[/]json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE','请求须使用 application/json。');
  if (request.headers['content-encoding']) throw new ServiceError('UNSUPPORTED_MEDIA_TYPE','暂不接受压缩的 JSON 请求。');
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new ServiceError('PAYLOAD_TOO_LARGE',`请求不能超过 ${limit} 字节。`);
  return new Promise((resolve,reject) => {
    let bytes = 0; let exceeded = false; const chunks: Buffer[] = [];
    request.on('data',(chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) { if (!exceeded) { exceeded = true; chunks.length = 0; reject(new ServiceError('PAYLOAD_TOO_LARGE',`请求不能超过 ${limit} 字节。`)); } return; }
      chunks.push(chunk);
    });
    request.once('end',() => {
      if (exceeded) return;
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value as Record<string, unknown>);
      } catch { reject(new ServiceError('INVALID_REQUEST','请求正文必须是有效的 JSON 对象。')); }
    });
    request.once('error',reject);
    request.once('aborted',() => reject(new ServiceError('INVALID_REQUEST','请求已中断。')));
  });
}
