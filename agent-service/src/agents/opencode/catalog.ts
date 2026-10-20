import { createHash } from 'node:crypto';
import { AgentError } from '../errors.js';
import type { OpenCodeTransport } from './transport.js';

export interface OpenCodeNativeModel {
  id: string; variants: string[]; tools: boolean; input: string[]; output: string[];
}
export interface OpenCodeNativeAgent { id: string; name: string; mode: 'primary' | 'subagent' | 'all'; hidden: boolean }
export interface OpenCodeNativeCommand { id: string; description: string | null }
/** Paths and content hashes remain plugin-private for source/revision freezing. */
export interface OpenCodeNativeSkill { id: string; name: string; description: string | null; path: string; contentSha256: string }
export interface OpenCodeNativeCatalog {
  models: OpenCodeNativeModel[]; agents: OpenCodeNativeAgent[]; commands: OpenCodeNativeCommand[]; skills: OpenCodeNativeSkill[];
  revision: string;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('protocol_error');
  return value as RecordValue;
}
function text(value: unknown, maximum = 256, empty = false): string {
  if (typeof value !== 'string' || !empty && !value || value.length > maximum || /[\x00-\x1f]/.test(value)) throw new AgentError('protocol_error');
  return value;
}
function description(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new AgentError('protocol_error');
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new AgentError('protocol_error');
  return value;
}
function envelope(value: unknown, directory: string, maximum = 512): unknown[] {
  const entry = record(value);
  if (record(entry.location).directory !== directory) throw new AgentError('protocol_error');
  return array(entry.data, maximum);
}
function unique<T>(values: T[], id: (entry: T) => string): T[] {
  if (new Set(values.map(id)).size !== values.length) throw new AgentError('protocol_error');
  return values.sort((a, b) => id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
}
function strings(value: unknown): string[] { return unique(array(value, 64).map(entry => text(entry, 128)), entry => entry); }

/** v2.0.29 model.list's handler awaits the native Plugin activation barrier
 * (despite the older endpoint description saying it is a raw snapshot). Read
 * it FIRST; concurrently reading other catalogs can still see initial empties.
 * The barrier covers announced plugin updates, not an atomic filesystem view.
 * No scratch session, prompt, command, reload or authentication flow is sent. */
export async function readOpenCodeNativeCatalog(transport: Pick<OpenCodeTransport, 'request'>, directory: string, signal: AbortSignal, requiredConfigurationFiles: readonly string[] = []): Promise<OpenCodeNativeCatalog> {
  signal.throwIfAborted();
  const query = '?location%5Bdirectory%5D=' + encodeURIComponent(directory);
  const modelResponse = await transport.request('/api/model' + query, { signal });
  signal.throwIfAborted();
  const pluginResponse = await transport.request('/api/plugin' + query, { signal });
  for (const value of envelope(pluginResponse, directory, 256)) {
    const status = record(record(value).state).status;
    if (status === 'failed') throw new AgentError('invalid_configuration');
    if (status !== 'active') throw new AgentError('protocol_error');
  }
  if (requiredConfigurationFiles.length) {
    // Native parsing may skip malformed documents and still return HTTP 200.
    // Only compare source identities; raw config/credentials are never returned.
    const entries = array(await transport.request('/api/config' + query, { signal }), 1024);
    const present = new Set(entries.map(record).filter(entry => entry.type === 'document').map(entry => entry.path));
    if (requiredConfigurationFiles.some(path => !present.has(path))) throw new AgentError('invalid_configuration');
  }
  const [agentResponse, commandResponse, skillResponse] = await Promise.all(['agent', 'command', 'skill'].map(kind => transport.request('/api/' + kind + query, { signal })));
  signal.throwIfAborted();
  const models = unique(envelope(modelResponse, directory).map(value => {
    const entry = record(value), capabilities = record(entry.capabilities);
    if (typeof capabilities.tools !== 'boolean' || entry.enabled !== true) throw new AgentError('protocol_error');
    const provider = text(entry.providerID), id = text(entry.id);
    if (provider.includes('/') || provider.includes('#') || id.includes('#')) throw new AgentError('protocol_error');
    return { id: text(provider + '/' + id), variants: unique(array(entry.variants, 64).map(variant => text(record(variant).id, 64)), id => id),
      tools: capabilities.tools, input: strings(capabilities.input), output: strings(capabilities.output) };
  }), entry => entry.id);
  const agents = unique(envelope(agentResponse, directory, 256).map(value => {
    const entry = record(value);
    if (!['primary', 'subagent', 'all'].includes(String(entry.mode)) || typeof entry.hidden !== 'boolean') throw new AgentError('protocol_error');
    return { id: text(entry.id), name: text(entry.name), mode: entry.mode as OpenCodeNativeAgent['mode'], hidden: entry.hidden };
  }), entry => entry.id);
  const commands = unique(envelope(commandResponse, directory, 256).map(value => {
    const entry = record(value);
    return { id: text(entry.name), description: entry.description === undefined ? null : description(entry.description) };
  }), entry => entry.id);
  const skills = unique(envelope(skillResponse, directory).map(value => {
    const entry = record(value);
    if (typeof entry.content !== 'string' || Buffer.byteLength(entry.content) > 1024 * 1024) throw new AgentError('protocol_error');
    return { id: text(entry.id), name: text(entry.name), description: entry.description === undefined ? null : description(entry.description), path: text(entry.path, 8192),
      contentSha256: createHash('sha256').update(entry.content).digest('hex') };
  }), entry => entry.id);
  const projection = { models, agents, commands, skills };
  return { ...projection, revision: createHash('sha256').update(JSON.stringify(projection)).digest('hex') };
}
