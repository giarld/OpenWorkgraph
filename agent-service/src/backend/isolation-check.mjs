// Opt-in LOCAL diagnostic. Never sets production isolation evidence.
// No model calls, login, credential copying, auth/config-file edits, or cleanup.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
if (process.argv[2] !== '--run-disposable-local-checks' || process.argv.slice(3).some(x => !['--slash-tmp', '--deny-tmp-aliases', '--explicit-system-roots', '--app-server'].includes(x)) || process.argv.length > 7 || process.platform !== 'darwin') {
  console.error('macOS only; opt in with --run-disposable-local-checks.');
  process.exitCode = 2;
} else {
  const root = await realpath(await mkdtemp(join(process.argv.includes('--slash-tmp') ? '/tmp' : tmpdir(), 'owg-sandbox-check-')));
  const work = join(root, 'project'), input = join(root, 'input'), output = join(root, 'output');
  await Promise.all([work, input, output].map(path => mkdir(path, { mode: 0o700 })));
  const outside = join(root, 'outside-marker.txt'), readonly = join(input, 'input-marker.txt');
  await writeFile(outside, 'DISPOSABLE_OUTSIDE_MARKER', { flag: 'wx', mode: 0o600 });
  await writeFile(readonly, 'DISPOSABLE_READONLY_INPUT', { flag: 'wx', mode: 0o600 });
  const crossRoot = await realpath(await mkdtemp('/tmp/owg-cross-boundary-'));
  const crossMarker = join(crossRoot, 'cross-marker.txt');
  await writeFile(crossMarker, 'DISPOSABLE_CROSS_TMP', { flag: 'wx', mode: 0o600 });
  const filesystem = { ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny', [work]: 'write', [input]: 'read', [output]: 'write', [outside]: 'deny' };
  filesystem[crossMarker] = 'deny';
  if (process.argv.includes('--explicit-system-roots')) {
    delete filesystem[':minimal'];
    for (const path of ['/bin', '/sbin', '/usr', '/System']) filesystem[path] = 'read';
  }
  if (process.argv.includes('--deny-tmp-aliases')) {
    filesystem['/tmp'] = 'deny'; filesystem['/private/tmp'] = 'deny';
    for (const [path, access] of Object.entries(filesystem)) if (path.startsWith('/private/tmp/')) filesystem[path.slice('/private'.length)] = access;
  }
  const profile = 'permissions.owg_audit={filesystem={' + Object.entries(filesystem).map(([k,v]) => JSON.stringify(k)+'='+JSON.stringify(v)).join(',') + '},network={enabled=false}}';
  const cleanEnv = { ...process.env };
  for (const name of Object.keys(cleanEnv)) if (name.startsWith('CODEX_')) delete cleanEnv[name];
  async function command(executable, args, env) {
    try { const r = await exec(executable, args, { cwd: work, env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096 }); return { exit: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim(), timedOut: false }; }
    catch (e) { return { exit: typeof e.code === 'number' ? e.code : null, stdout: String(e.stdout ?? '').trim(), stderr: String(e.stderr ?? '').trim(), timedOut: Boolean(e.killed) }; }
  }
  const version = await command('codex', ['--version'], cleanEnv);
  const checks = [];
  function record(mode, name, expected, result) { checks.push({ mode, name, expected, ...result, passed: expected === 'allow' ? result.exit === 0 : result.exit !== 0 && /Operation not permitted|Permission denied/.test(result.stderr) }); }
  for (const [mode, env] of [['inherited-env', process.env], ['without-CODEX-env', cleanEnv]]) {
    for (const [name, expected, argv] of [
      ['allowed-input-read', 'allow', ['/bin/cat', readonly]],
      ['allowed-output-write', 'allow', ['/bin/sh', '-c', 'printf OK > "$1"', 'probe', join(output,mode+'.txt')]],
      ['outside-read', 'deny', ['/bin/cat', outside]],
      ['cross-slash-tmp-read', 'deny', ['/bin/cat', crossMarker]],
      ['readonly-input-write', 'deny', ['/bin/sh', '-c', 'printf CHANGED >> "$1"', 'probe', readonly]],
    ]) record(mode, name, expected, await command('codex', ['sandbox', '-c', profile, '-P', 'owg_audit', '-C', work, '--', ...argv], env));
  }
  record('builtin-read-only', 'readonly-input-write', 'deny', await command('codex', ['sandbox', '-P', ':read-only', '-C', work, '--', '/bin/sh', '-c', 'printf BUILTIN >> "$1"', 'probe', readonly], cleanEnv));
  // Diagnostic control only: the OS policy denies these disposable markers.
  const seatbelt = '(version 1)(allow default)(deny file-read-data (literal '+JSON.stringify(outside)+'))(deny file-write* (subpath '+JSON.stringify(input)+'))';
  for (const [name, argv] of [
    ['outside-read', ['/bin/cat', outside]],
    ['readonly-input-write', ['/bin/sh', '-c', 'printf OS >> "$1"', 'probe', readonly]],
  ]) record('direct-seatbelt-control', name, 'deny', await command('/usr/bin/sandbox-exec', ['-p', seatbelt, ...argv], cleanEnv));
  if (process.argv.includes('--app-server')) {
    // Uses only config/read and standalone command/exec: no account or turn calls.
    const { StdioRpc } = await import('../../dist/backend/stdio.js');
    const rpc = new StdioRpc({ cwd: work, env: cleanEnv, args: ['app-server', '--stdio', '-c', profile], timeoutMs: 6000 });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'owg_isolation_check', version: '1' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      const effective = await rpc.request('config/read', { includeLayers: false });
      if (effective.config?.permissions?.owg_audit?.filesystem?.[crossMarker] !== 'deny') throw new Error('Profile was not loaded');
      for (const [name, expected, argv] of [
        ['allowed-input-read', 'allow', ['/bin/cat', readonly]],
        ['allowed-output-write', 'allow', ['/bin/sh', '-c', 'printf OK > "$1"', 'probe', join(output,'rpc.txt')]],
        ['outside-read', 'deny', ['/bin/cat', outside]],
        ['readonly-input-write', 'deny', ['/bin/sh', '-c', 'printf CHANGED >> "$1"', 'probe', readonly]],
        ['cross-slash-tmp-read', 'deny', ['/bin/cat', crossMarker]],
      ]) {
        const r = await rpc.request('command/exec', { permissionProfile: 'owg_audit', command: argv, cwd: work, timeoutMs: 3000, outputBytesCap: 2048 });
        record('app-server-command-exec', name, expected, { exit: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false });
      }
    } catch (e) { checks.push({ mode: 'app-server-command-exec', passed: false, error: e.message }); }
    finally { rpc.close(); }
  }
  console.log(JSON.stringify({ version: version.stdout, root, crossRoot, gate: 'unchanged-closed', inferenceCalls: 0, checks }, null, 2));
  // Even all CLI checks passing cannot certify app-server/turn/tool enforcement.
  process.exitCode = checks.every(check => check.passed) ? 0 : 1;
}
