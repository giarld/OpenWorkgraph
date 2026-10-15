import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

function file(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Resolve on every launch: the Workspace can outlive installation or upgrades.
 * Windows npm shims cannot be spawned without a shell; use the package entry.
 * Explicit device executables never fall back to another installation. */
export function claudeCommand(executable: string | undefined, args: readonly string[], environment: NodeJS.ProcessEnv, platform = process.platform): { executable: string; args: string[] } {
  const command = executable ?? 'claude';
  const defaultCommand = command === 'claude';
  const shim = platform === 'win32' && isAbsolute(command) && /[\\/]claude[.](?:cmd|ps1)$/i.test(command);
  if (!defaultCommand && !shim) return { executable: command, args: [...args] };
  const path = platform === 'win32'
    ? Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
    : environment.PATH ?? '';
  const directories = shim ? [dirname(command)] : path.split(platform === 'win32' ? ';' : ':').map(value => value.replace(/^"|"$/g, '')).filter(value => isAbsolute(value));
  if (defaultCommand) {
    const home = (platform === 'win32' ? environment.USERPROFILE : environment.HOME) || homedir();
    directories.push(join(home, '.local', 'bin'));
    if (platform === 'win32' && environment.APPDATA) directories.push(join(environment.APPDATA, 'npm'));
    if (platform === 'darwin') directories.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  for (const directory of new Set(directories)) {
    const native = join(directory, platform === 'win32' ? 'claude.exe' : 'claude');
    if (!shim && file(native)) return { executable: native, args: [...args] };
    if (platform !== 'win32') continue;
    const packageRoot = join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
    const binary = join(packageRoot, 'bin', 'claude.exe');
    if (file(binary)) return { executable: binary, args: [...args] };
    for (const entry of ['cli.js', 'cli-wrapper.cjs']) {
      const script = join(packageRoot, entry);
      if (file(script)) return { executable: process.execPath, args: [script, ...args] };
    }
  }
  return { executable: command, args: [...args] };
}
