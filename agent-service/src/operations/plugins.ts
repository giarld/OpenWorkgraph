import type { DatabaseSync } from 'node:sqlite';
import { Graphs } from '../graphs.js';
import { PluginManagement } from '../plugin-management.js';

/** Trusted local declarative registration only: no import(), executable files,
 * dependency installation, or node migrations are implied by registration. */
export function registerLocalPlugin(db: DatabaseSync, serviceId: string, serialized: string) {
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Plugin manifest exceeds 1 MiB');
  const contract = new PluginManagement(new Graphs(db, serviceId)).registerTrustedLocal(JSON.parse(serialized) as unknown);
  return { registered: true, typeId: contract.typeId, pluginId: contract.pluginId, version: contract.version, schemaVersion: contract.schemaVersion };
}
