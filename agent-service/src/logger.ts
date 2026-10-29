import { appendFileSync, constants, closeSync, openSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir } from './operations/files.js';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogFields { requestId?: string; method?: string; statusCode?: number; durationMs?: number; code?: string; runId?: string; status?: string; clients?: number; port?: number; backupId?: string; operation?: string; stage?: string; errorName?: string; errorCode?: string; errorMessage?: string; errorStack?: string; }
export interface Logger { write(level: LogLevel, event: string, fields?: LogFields): void; }
export const silentLogger: Logger = { write() {} };
const fieldNames = new Set(['requestId', 'method', 'statusCode', 'durationMs', 'code', 'runId', 'status', 'clients', 'port', 'backupId', 'operation', 'stage', 'errorName', 'errorCode']);
const diagnosticFields = new Set(['errorMessage', 'errorStack']);
/** Diagnostic text stays local; strip common credential forms before either
 * terminal or file output. Never pass request bodies or agent output here. */
function redactDiagnostic(value: string): string {
  return value.replace(/(Bearer\s+)[^\s"',;]+/gi, '$1<redacted>')
    .replace(/(["']?(?:authorization|password|passwd|token|api[_-]?key|access[_-]?key|secret|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '<redacted>');
}
export function errorLogFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorName: 'NonErrorThrown', errorMessage: 'A non-Error value was thrown' };
  let code = (error as NodeJS.ErrnoException).code;
  const causes: string[] = []; let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++, current = current.cause) {
    code ??= (current as NodeJS.ErrnoException).code;
    causes.push(current.stack ?? current.message);
  }
  return { errorName: error.name, ...(typeof code === 'string' ? { errorCode: code } : {}), errorMessage: redactDiagnostic(error.message).slice(0, 2048), errorStack: redactDiagnostic(causes.join('\nCaused by: ')).slice(0, 8192) };
}
const dayMs = 86_400_000;
const productionEvents = new Set(['service.listening', 'service.started', 'service.draining', 'service.interrupting', 'service.stopped', 'service.backup_ready', 'service.restored']);
/** Structured fields and redacted local exceptions only; never pass request
 * bodies, credentials or agent output. */
export class RuntimeLogger implements Logger {
  private timer?: NodeJS.Timeout;
  private failed = false;
  private closed = false;
  private lastDate = '';
  private constructor(private directory: string, private now: () => number, private output: (line: string) => void, private production: boolean, private background: boolean) {}
  static async create(root: string, background: boolean, options: { now?: () => number; output?: (line: string) => void; environment?: string } = {}): Promise<RuntimeLogger> {
    const environment = options.environment ?? process.env.NODE_ENV;
    const production = environment === 'production' || (background && environment !== 'development');
    const logger = new RuntimeLogger(await privateDir(join(root, 'logs')), options.now ?? Date.now, options.output ?? (line => { process.stderr.write(line); }), production, background);
    logger.prune();
    logger.timer = setInterval(() => { try { logger.prune(); } catch { logger.reportFailure(); } }, 60_000);
    logger.timer.unref();
    return logger;
  }
  private reportFailure(): void {
    if (!this.failed) { this.failed = true; try { this.output(JSON.stringify({ time: new Date(this.now()).toISOString(), level: 'error', event: 'logging.failed' }) + '\n'); } catch { /* Logging must not break task execution. */ } }
  }
  /** Keep today and the preceding six UTC dates; only remove our own regular files. */
  prune(): void {
    if (!this.directory) return;
    const cutoff = new Date(this.now() - 6 * dayMs).toISOString().slice(0, 10);
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      const match = /^service-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
      if (match && match[1]! < cutoff && entry.isFile()) unlinkSync(join(this.directory, entry.name));
    }
    this.lastDate = new Date(this.now()).toISOString().slice(0, 10);
  }
  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (this.closed) return;
    if (this.production && level === 'info' && !productionEvents.has(event)) return;
    try {
      const time = new Date(this.now()).toISOString();
      const safe = Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => {
        if (diagnosticFields.has(key) && typeof value === 'string') return [[key, redactDiagnostic(value).slice(0, key === 'errorStack' ? 8192 : 2048)]];
        return fieldNames.has(key) && (typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) ? [[key, value]] : [];
      }));
      const line = JSON.stringify({ time, level, event: /^[a-zA-Z0-9_.-]{1,80}$/.test(event) ? event : 'unknown', ...safe }) + '\n';
      let persisted = true;
      try { if (this.background || level !== 'info') {
        if (this.lastDate !== time.slice(0, 10)) this.prune();
        const path = join(this.directory, 'service-' + time.slice(0, 10) + '.log');
        try { if (!lstatSync(path).isFile()) throw new Error('Invalid log file'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try { appendFileSync(fd, line, 'utf8'); } finally { closeSync(fd); }
      } } catch { persisted = false; this.reportFailure(); }
      if (!this.background) this.output(line);
      if (persisted) this.failed = false;
    } catch { this.reportFailure(); }
  }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); }
}
