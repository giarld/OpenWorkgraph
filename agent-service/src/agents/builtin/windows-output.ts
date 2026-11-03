import { execFile } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';
import iconv from 'iconv-lite';

let outputEncoding: Promise<string> | undefined;

/** Query only host encoding metadata, with no task argv or credential environment. */
function systemOutputEncoding(): Promise<string> {
  outputEncoding ??= new Promise<string>((resolve, reject) => {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    execFile(join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([Console]::OutputEncoding.CodePage)'],
      { encoding: 'ascii', windowsHide: true, timeout: 5000, maxBuffer: 64, env: { SYSTEMROOT: root, WINDIR: root } },
      (error, stdout) => {
        const codePage = stdout.trim(), encoding = 'cp' + codePage;
        if (error || !/^[0-9]{3,5}$/.test(codePage) || !iconv.encodingExists(encoding)) reject(new Error('Windows output encoding is unavailable'));
        else resolve(encoding);
      });
  }).catch(error => { outputEncoding = undefined; throw error; });
  return outputEncoding;
}

/** Prefer explicit BOMs and valid UTF-8 (Node/Python/shims). Legacy console
 * output uses the host code page, never a guessed language or a task setting.
 * The optional reader is a private seam for code-page-independent regression. */
export async function decodeWindowsCommandOutput(bytes: Buffer, readEncoding: () => Promise<string> = systemOutputEncoding): Promise<string> {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes, 'utf16-le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes, 'utf16-be');
  if (isUtf8(bytes)) return bytes.toString('utf8');
  return iconv.decode(bytes, await readEncoding());
}
