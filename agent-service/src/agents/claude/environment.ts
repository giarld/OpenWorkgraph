import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../errors.js';

const deviceKeys = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_REASONING_MODEL',
]);
const modelKey = /^ANTHROPIC_DEFAULT_(?:HAIKU|SONNET|OPUS|FABLE)_MODEL(?:_NAME)?$/;

/** Keep native settings sources disabled. Only device authentication and model
 * routing are inherited; hooks, permissions, plugins and project settings aren't.
 * Values stay in the child environment, never arguments or frozen snapshots. */
export function claudeDeviceEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let settings: unknown;
  try {
    const bytes = readFileSync(join(environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json'));
    if (bytes.length > 1024 * 1024) throw new AgentError('invalid_configuration');
    settings = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...environment };
    throw new AgentError('invalid_configuration');
  }
  const result = { ...environment };
  const values = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as { env?: unknown }).env : undefined;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return result;
  for (const [key, value] of Object.entries(values)) {
    if (!deviceKeys.has(key) && !modelKey.test(key)) continue;
    if (typeof value !== 'string' || value.includes(String.fromCharCode(0)) || Buffer.byteLength(value) > 16384) throw new AgentError('invalid_configuration');
    if (result[key] === undefined) result[key] = value;
  }
  return result;
}
