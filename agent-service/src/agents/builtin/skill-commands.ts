import { isAbsolute, basename, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import type { FrozenSkill } from '@openworkgraph/protocol';
import type { BackendCallbacks } from '../../backend/types.js';
import type { BuiltinAgentCommandExecutor, BuiltinAgentCommandOutput } from './adapter.js';
import { AgentError } from '../errors.js';
import { redactSkillValues } from '../../backend/redaction.js';
import { BUILTIN_AGENT_LIMITS } from './limits.js';

/** A private tool dispatcher. Configuration values never become tool arguments,
 * shared process env, a skill catalogue entry or a public configuration field. */
export class BuiltinSkillCommands {
  private readonly skills: readonly FrozenSkill[];
  private readonly masks: Record<string, string> = {};
  constructor(skills: readonly FrozenSkill[], private readonly commands: BuiltinAgentCommandExecutor,
    private readonly lease: BackendCallbacks['withSkillEnvironment'],
    private readonly signal: AbortSignal,
    private readonly active: () => void,
    private readonly approve: (name: string, command: string) => Promise<void>,
    private readonly remember: (secrets: Readonly<Record<string, string>>) => void = () => {}) {
    this.skills = structuredClone(skills);
  }
  available(): boolean { return typeof this.commands.prepare === 'function'; }
  private check(): void { this.signal.throwIfAborted(); this.active(); }
  private secretValues(secrets: Record<string, string>): Record<string, string> {
    const masks: Record<string, string> = {};
    for (const value of Object.values(secrets)) {
      if (typeof value !== 'string') throw new AgentError('invalid_configuration');
      if (value) { masks['secret_' + Object.keys(masks).length] = value; this.masks['secret_' + Object.keys(this.masks).length] = value; }
    }
    this.remember(masks);
    return masks;
  }
  private result(value: BuiltinAgentCommandOutput, secrets: Record<string, string>): BuiltinAgentCommandOutput {
    if (!value || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' ||
        value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > (process.platform === 'win32' ? 0xffffffff : 255)) ||
        Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > BUILTIN_AGENT_LIMITS.toolResultBytes) throw new AgentError('execution_limit');
    return { exitCode: value.exitCode, stdout: redactSkillValues(value.stdout, secrets), stderr: redactSkillValues(value.stderr, secrets) };
  }
  redact(value: string): string { return redactSkillValues(value, this.masks); }
  sanitize(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.sanitize(item));
    if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.sanitize(item)]));
    }
    return value;
  }
  async run(skillId: string, argv: readonly string[], signal = this.signal, timeoutMs: number = BUILTIN_AGENT_LIMITS.commandMs): Promise<BuiltinAgentCommandOutput> {
    const check = () => { signal.throwIfAborted(); this.check(); };
    let pending: Promise<BuiltinAgentCommandOutput> | undefined;
    try {
      check();
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BUILTIN_AGENT_LIMITS.commandMs) throw new AgentError('invalid_configuration');
      if (!this.commands.prepare || typeof skillId !== 'string' || !Array.isArray(argv) || argv.length < 1 || argv.length > 128 ||
          argv.some(value => typeof value !== 'string' || value.length > 16000 || value.includes('\0')) ||
          !(isAbsolute(argv[0]!) || process.platform === 'win32' && /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(argv[0]!))) throw new AgentError('invalid_configuration');
      const candidates = this.skills.filter(skill => skill.skillId === skillId);
      if (candidates.length !== 1) throw new AgentError('permission_denied');
      const skill = candidates[0]!;
      if (skill.source !== 'openworkgraph' && (skill.source !== 'agent' || skill.backendId !== 'builtin' || skill.requiresConfiguration)) throw new AgentError('capability_unsupported');
      if (skill.source === 'openworkgraph' && !this.lease) throw new AgentError('runtime_unavailable');
      if (!isAbsolute(skill.path) || basename(skill.path) !== 'SKILL.md') throw new AgentError('invalid_configuration');
      const file = lstatSync(skill.path);
      if (!file.isFile() || file.isSymbolicLink()) throw new AgentError('invalid_configuration');
      const command = [...argv];
      await this.approve(skill.name, command.join(' '));
      check();
      const reservation = await this.commands.prepare({ command: command[0]!, args: command.slice(1), cwd: dirname(skill.path), signal, timeoutMs });
      check();
      if (skill.source !== 'openworkgraph') {
        pending = reservation.dispatch({});
        const result = await pending; check(); return this.result(result, {});
      }
      let dispatched = false;
      const result = await this.lease!(skill.skillId, (environment, secrets) => {
        check();
        if (dispatched) throw new AgentError('protocol_error');
        dispatched = true;
        const masks = this.secretValues(secrets);
        // No await here: the prepared executor must spawn/send before returning.
        const work = pending = reservation.dispatch({ ...environment }).then(value => this.result(value, masks));
        // Lease release can itself await filesystem work. Observe a fast exit
        // immediately, including when cancellation rejects before lease return.
        void work.catch(() => {});
        return work;
      });
      check();
      if (!dispatched) throw new AgentError('protocol_error');
      const value = await result.value; check(); return this.result(value, this.masks);
    } catch (error) {
      // Native/configuration errors can include private environment or file data.
      throw new AgentError(error instanceof AgentError ? error.reason : 'invalid_configuration');
    } finally {
      // A timeout during lease release must still await the command accepted
      // inside that lease before the adapter can begin another model request.
      if (pending) await Promise.allSettled([pending]);
    }
  }
}
