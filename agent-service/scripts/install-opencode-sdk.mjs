import { spawn } from 'node:child_process';
import { findPackageJSON } from 'node:module';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
async function sdkPresent(root) {
  try { return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name === '@opencode/sdk'; }
  catch { return false; }
}

/** npm may drop the optional SDK when an unused native grammar fails to build.
 * The Node adapter uses the published WASM grammars. Install its own dependency
 * tree without lifecycle scripts; never disable scripts for other dependencies.
 * This runs only during installation, never on a Web request or task launch. */
export async function installOpenCodeSdk({ root = packageRoot, environment = process.env, spawnProcess = spawn } = {}) {
  const omit = (environment.npm_config_omit ?? '').split(/\s+/);
  const include = (environment.npm_config_include ?? '').split(/\s+/);
  if (!include.includes('optional') && (omit.includes('optional') || environment.npm_config_optional === 'false')) return 'skipped';
  let installed;
  try { installed = findPackageJSON('@opencode/sdk', pathToFileURL(join(root, 'package.json'))); } catch {}
  const privateRoot = join(root, '.opencode-sdk');
  const sdk = join(privateRoot, 'node_modules', '@opencode', 'sdk');
  if (installed && await sdkPresent(dirname(installed)) || await sdkPresent(sdk)) return 'present';
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const range = manifest.optionalDependencies?.['@opencode/sdk'];
  if (typeof range !== 'string' || !range) throw Error('OpenCode dependency declaration is missing');
  const npmCli = environment.npm_execpath && basename(environment.npm_execpath) === 'npm-cli.js'
    ? environment.npm_execpath : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await access(npmCli);
  await mkdir(privateRoot, { recursive: true });
  await writeFile(join(privateRoot, 'package.json'), JSON.stringify({ private: true }), 'utf8');
  const env = { ...environment, npm_config_ignore_scripts: 'true' };
  for (const key of ['npm_config_workspace', 'npm_config_workspaces', 'npm_config_include_workspace_root']) delete env[key];
  const args = [npmCli, 'install', '--prefix', privateRoot, '--workspaces=false', '--ignore-scripts', '--include=optional',
    '--no-audit', '--no-fund', '--package-lock=false', '--no-save', '@opencode/sdk@' + range];
  await new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, args, { cwd: privateRoot, env, shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('OpenCode dependency installation failed')));
  });
  if (!await sdkPresent(sdk)) throw Error('OpenCode dependency installation is incomplete');
  return 'installed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await installOpenCodeSdk(); }
  catch {
    // Keep other Agents usable, while making an incomplete installation visible.
    console.error('OpenWorkgraph: OpenCode integration could not be installed. Check the network and reinstall OpenWorkgraph with npm install -g openworkgraph --include=optional. Other Agents remain available.');
  }
}
