#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { formatHelp } from './cli-help.js';
import { SERVICE_VERSION, normalizeShortPairingCode } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';
import { localControl } from './local-control.js';
import { fileURLToPath } from 'node:url';
import { acquireOperationsLock, manage, readInstance, requestInstance, rootPath, startBackground, waitUntilStopped } from './operations/lifecycle.js';
import { serveManaged } from './operations/daemon.js';
import { OperationsLog } from './operations/logs.js';
import { withOfflineBackups, withReadBackups } from './operations/local-admin.js';
import { writeNew, readSafe } from './operations/files.js';
import { localCapacity } from './operations/capacity.js';
import { registerLocalPlugin } from './operations/plugins.js';
import { Repositories } from './persistence/repositories.js';
import { inspectClientCode } from './client-pairing.js';
import { createInterface } from 'node:readline/promises';
import { acquireServiceSingleton, rememberServiceDirectory, selectedServiceDirectory } from './operations/cli-context.js';
import { formatCliError, formatPairingResult, printOutput } from './cli-output.js';
import { updateAgentService } from './operations/update.js';
const rawOutputJson = process.argv.slice(2).some(argument => argument === '--output-json' || argument === '--json');
function printPairingResult(value: unknown, outputJson = false) { console.log(formatPairingResult(value, outputJson)); }
async function main() {
  const { values,positionals } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' }, origin: { type: 'string' }, 'client-code': { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' }, 'output-json': { type: 'boolean' }, host: { type: 'string', default: '0.0.0.0' }, port: { type: 'string', default: '14317' }, sha256: { type: 'string' }, output: { type: 'string' }, 'idempotency-key': { type: 'string' }, 'interrupt-and-stop': { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' } } });
  const outputJson = values['output-json'] || values.json || false;
  if (values.version) { console.log(SERVICE_VERSION); return; }
  if (values.help || positionals.length === 0) {
    console.log(formatHelp());
    return;
  }
  const command = positionals[0]!;
  if (command === 'version') {
    if (positionals.length !== 1) throw new ServiceError('INVALID_REQUEST', 'The version command does not accept arguments.');
    console.log(SERVICE_VERSION);
    return;
  }
  if (values['data-dir'] !== undefined && command !== 'start' && command !== 'serve') throw new ServiceError('INVALID_REQUEST', '--data-dir is only available for start and serve; this command uses the saved local service directory.');
  if (!['start', 'serve', 'restart', 'update', 'stop', 'status', 'logs', 'pair', 'pair-code', 'sessions', 'revoke-session', 'capacity', 'plugin', 'backup', 'restore'].includes(command)) throw new ServiceError('INVALID_REQUEST', 'Unknown command. Use --help to see available commands.');
  const starting = command === 'start' || command === 'serve';
  const dataDir = (starting || command === 'restart' || command === 'update')
    ? values['data-dir'] ?? await selectedServiceDirectory().catch(error => {
        if (error instanceof ServiceError && error.code === 'SERVICE_NOT_RUNNING') return undefined;
        if (command === 'update' && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      })
    : await selectedServiceDirectory();
  if (command === 'pair' || (command === 'pair-code' && values['client-code'])) {
    if (positionals.length !== 1 || !values['client-code'] || values.origin !== undefined) throw new ServiceError('INVALID_REQUEST', 'Use pair --client-code <CLIENT_CODE>; --origin is not required.');
    const enteredCode = values['client-code'].trim();
    const shortCode = normalizeShortPairingCode(enteredCode);
    const clientCode = shortCode ? await manage(dataDir, 'resolve-client', shortCode) as string : enteredCode;
    const { client, fingerprint } = inspectClientCode(clientCode);
    console.error(`Client origin: ${client.origin}\nPublic key fingerprint SHA-256: ${fingerprint}\nThis client will receive runtime management access. Verify the origin and fingerprint shown in the browser.`);
    if (!values.yes) {
      if (!process.stdin.isTTY) throw new ServiceError('INVALID_REQUEST', 'Non-interactive terminals must pass --yes to approve this client. No authorization was issued.');
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      let accepted: string;
      try { accepted = await prompt.question('Allow this client to pair? [y/N] '); } finally { prompt.close(); }
      if (!/^(y|yes)$/i.test(accepted.trim())) { console.error('Cancelled. No authorization was issued.'); return; }
    }
    // Only the live owner may issue a new client grant. Never bypass IPC failure
    // by opening a running database from a second process.
    const result = await manage(dataDir, shortCode ? 'pair-short' : 'pair-client', shortCode ? JSON.stringify({ code: shortCode, clientCode }) : clientCode);
    printPairingResult(result, outputJson);
    return;
  }
  if (command === 'plugin') {
    if (positionals[1] !== 'register' || positionals.length !== 3) throw new Error('Use plugin register TRUSTED_MANIFEST.json');
    const manifest = (await readSafe(positionals[2]!, 1024 * 1024)).toString();
    let result: unknown;
    try { result = await manage(dataDir, 'plugin-register', manifest); }
    catch { result = await withOfflineBackups(dataDir, async backups => registerLocalPlugin(backups.db, new Repositories(backups.db).identity(), manifest)); }
    printOutput('plugin register', result, outputJson); return;
  }
  if (command === 'capacity') {
    if (positionals.length > 2) throw new Error('Unexpected capacity arguments');
    let result: unknown;
    try { result = await manage(dataDir, 'capacity', positionals[1]); }
    catch { result = await withOfflineBackups(dataDir, async backups => localCapacity(backups.db, positionals[1])); }
    printOutput('capacity', result, outputJson); return;
  }
  if (['start','restart','update','stop','status','logs'].includes(command)) {
    if (positionals.length !== 1) throw new Error('Unexpected arguments');
    if (command === 'update') {
      printOutput('update', await updateAgentService(dataDir, fileURLToPath(import.meta.url), Boolean(values['interrupt-and-stop']), outputJson), outputJson);
    } else if (command === 'restart') {
      if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new ServiceError('INVALID_REQUEST', 'Port must be an integer from 0 to 65535');
      let record: Awaited<ReturnType<typeof readInstance>> | undefined;
      try {
        record = await readInstance(dataDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      let status: { listenHost?: string; localEndpoint: string } | undefined;
      if (record) try {
        status = await requestInstance(record, 'status') as { listenHost?: string; localEndpoint: string };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error;
      }
      if (!record || !status) {
        const args = ['--host', values.host, '--port', values.port];
        if (dataDir) args.push('--data-dir', dataDir);
        printOutput('restart', await startBackground(fileURLToPath(import.meta.url), args), outputJson);
        return;
      }
      // Older daemons expose reachable endpoints, which cannot distinguish a
      // wildcard listener from a loopback-only listener. Never guess its scope.
      const hostSpecified = process.argv.slice(2).some(arg => arg === '--host' || arg.startsWith('--host='));
      const portSpecified = process.argv.slice(2).some(arg => arg === '--port' || arg.startsWith('--port='));
      const host = hostSpecified ? values.host : status.listenHost;
      const port = portSpecified ? values.port : new URL(status.localEndpoint).port || '80';
      if (!host) throw new ServiceError('INVALID_REQUEST', 'The older runtime did not report its listen address. Use restart --host <ORIGINAL_ADDRESS>; the runtime has not been stopped.');
      if (!/^\d+$/.test(port) || Number(port) > 65535) throw new ServiceError('INVALID_REQUEST', 'Port must be an integer from 0 to 65535');
      await requestInstance(record, values['interrupt-and-stop'] ? 'interrupt-and-stop' : 'stop');
      await waitUntilStopped(record);
      printOutput('restart', await startBackground(fileURLToPath(import.meta.url), ['--data-dir', dataDir!, '--host', host, '--port', port]), outputJson);
    } else if (command === 'start') {
      const args = ['--host', values.host, '--port', values.port];
      if (dataDir) args.push('--data-dir', dataDir);
      printOutput('start', await startBackground(fileURLToPath(import.meta.url), args), outputJson);
    } else if (command === 'logs') printOutput('logs', await new OperationsLog(rootPath(dataDir)).read(), outputJson);
    else printOutput(command, await manage(dataDir, command === 'status' ? 'status' : values['interrupt-and-stop'] ? 'interrupt-and-stop' : 'stop'), outputJson);
    return;
  }
  if (command === 'backup' || command === 'restore') {
    const action = positionals[1], path = positionals[2];
    if (command === 'backup' && action === 'create') {
      if (positionals.length !== 2) throw new Error('Unexpected backup arguments');
      // Online IPC is authenticated; on refusal, offline acquisition fails closed
      // if any instance (including a maintenance operation) owns the directory.
      let result: unknown;
      try { result = await manage(dataDir, 'backup-create', values['idempotency-key']); }
      catch { result = await withOfflineBackups(dataDir, backups => backups.create(values['idempotency-key'])); }
      printOutput('backup create', result, outputJson); return;
    }
    const useBackups = command === 'restore' && action === 'apply' ? withOfflineBackups : withReadBackups;
    const result = await useBackups(dataDir, async backups => {
      if (command === 'backup' && action === 'list' && positionals.length === 2) return backups.list();
      if (command === 'backup' && action === 'download' && path && values.output && positionals.length === 3) {
        const download = await backups.readDownload(path); await writeNew(values.output, download.body); return { output: values.output, bytes: download.body.length };
      }
      if (command === 'restore' && action === 'preview' && path && positionals.length === 3) return backups.previewRestore(path);
      if (command === 'restore' && action === 'apply' && path && values.sha256 && positionals.length === 3) {
        await backups.restore(path, values.sha256); return { restored: true, invalidatesAllSessions: true, pausesQueuedRuns: true };
      }
      throw new Error('Invalid backup/restore arguments; use --help');
    });
    printOutput(command + ' ' + action, result, outputJson); return;
  }
  if (['pair-code','sessions','revoke-session'].includes(positionals[0]!)) {
    const command = positionals[0]!;
    if (command === 'pair-code' && !values.origin) throw new ServiceError('INVALID_REQUEST', 'pair-code requires the web origin in --origin.');
    if (command === 'pair-code') console.error('Legacy pairing compatibility: new clients should use pair --client-code <CLIENT_CODE>; --origin is not required.');
    if (positionals.length !== (command === 'revoke-session' ? 2 : 1)) throw new ServiceError('INVALID_REQUEST', 'Invalid command arguments. Use --help.');
    // Live admin commands run inside the owning instance. Offline session
    // inspection/revocation acquires maintenance ownership before SQLite opens.
    try {
      const result = await manage(dataDir, command as 'pair-code'|'sessions'|'revoke-session', command === 'pair-code' ? values.origin : positionals[1]);
      if (command === 'pair-code') printPairingResult(result, outputJson);
      else printOutput(command, result, outputJson);
      return;
    } catch { /* The kernel lock below distinguishes offline from an IPC refusal. */ }
    const lock = await acquireOperationsLock(dataDir);
    let control: ReturnType<typeof localControl>;
    try { control = localControl(lock.root); } catch (error) { await lock.release(); throw error; }
    try {
      if (command === 'pair-code') printPairingResult(await control.pairingCode(values.origin!), outputJson);
      else if (command === 'sessions') printOutput('sessions', control.auth.list(), outputJson);
      else { control.auth.revokeLocal(positionals[1]!); printOutput('revoke-session', {revoked:positionals[1],acceptedTasksUnaffected:true}, outputJson); }
    } finally { control.close(); await lock.release(); }
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'serve') throw new ServiceError('INVALID_REQUEST', 'Unknown command. Use --help to see available commands.');
  if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new ServiceError('INVALID_REQUEST','Port must be an integer from 0 to 65535');
  const singleton = await acquireServiceSingleton();
  let daemon: Awaited<ReturnType<typeof serveManaged>>;
  try { daemon = await serveManaged(dataDir, values.host, Number(values.port), () => singleton.release()); }
  catch (error) { await singleton.release(); throw error; }
  try { await rememberServiceDirectory(daemon.lock.root); }
  catch (error) { await daemon.stop(true); throw error; }
  const status = { ...daemon.status(), mode: 'pairing', pairingCommand: 'openworkgraph pair --client-code <CLIENT_CODE>' };
  printOutput('status', status, outputJson);
  if (process.send) process.send({ ok: true, status });
}
main().catch(error => {
  const message = error instanceof Error ? error.message : 'Startup failed';
  if (process.send) process.send({ ok: false, error: message });
  console.error(formatCliError(error, rawOutputJson));
  process.exitCode = 1;
});
