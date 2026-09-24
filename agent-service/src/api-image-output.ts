import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from '@openworkgraph/protocol';
import { runDirectories, type DataDirectories } from './directories.js';
import { ServiceError } from './errors.js';
import { validateImageOutput } from './publication.js';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/** Publishes nothing itself: the existing Publication re-reads and validates these files. */
export async function stageApiImageOutput(run: Run, dirs: DataDirectories, image: Buffer, publicMetadata: { providerId: string; modelId: string; inputDigest: string }): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(publicMetadata.providerId) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(publicMetadata.modelId) || ['.','..'].includes(publicMetadata.modelId) || !/^[a-f0-9]{64}$/.test(publicMetadata.inputDigest) || publicMetadata.inputDigest !== run.inputDigest) throw new ServiceError('INPUT_BLOCKED', '输出配置与冻结 Run 不一致。');
  const mime = validateImageOutput(image);
  const suffix = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[mime];
  const root = runDirectories(dirs, run.id).output;
  if ((await readdir(root)).length) throw new ServiceError('CONFLICT', 'API Run 输出目录非空，不能覆盖或重发。');
  const note = Buffer.from('# 图片生成结果\n\n服务商：' + publicMetadata.providerId + '\n\n模型：' + publicMetadata.modelId + '\n\n输入摘要：' + run.inputDigest + '\n', 'utf8');
  const outputs = [
    { outputKey: 'image', path: 'image.' + suffix, mime, bytes: image.length, sha256: sha256(image) },
    { outputKey: 'description', path: 'description.md', mime: 'text/markdown', bytes: note.length, sha256: sha256(note) },
  ];
  const manifest = Buffer.from(JSON.stringify({ outputs }), 'utf8');
  if (manifest.length > 64 * 1024) throw new ServiceError('PAYLOAD_TOO_LARGE', '输出清单超出限制。');
  await writeExclusive(join(root, outputs[0]!.path), image);
  await writeExclusive(join(root, outputs[1]!.path), note);
  // A complete manifest is the last durable commit marker for Publication.
  await writeExclusive(join(root, 'manifest.json'), manifest);
}
