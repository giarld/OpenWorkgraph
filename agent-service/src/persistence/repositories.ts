import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Json, ServiceEvent } from '@openworkgraph/protocol';
import { ServiceError } from '../errors.js';
import { atomic, transaction } from './database.js';
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ServiceError('INVALID_REQUEST', 'Non-finite JSON number');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new ServiceError('INVALID_REQUEST', 'Invalid JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key]!)).join(',') + '}';
}
/** Same digest as canonicalJson, without joining an entire resource bundle. */
export function canonicalJsonHash(value: Json): string {
  const hash = createHash('sha256');
  function visit(item: Json): void {
    if (item === null || typeof item !== 'object') { hash.update(canonicalJson(item)); return; }
    const array = Array.isArray(item);
    hash.update(array ? '[' : '{');
    const keys = array ? item.map((_, index) => String(index)) : Object.keys(item).sort();
    keys.forEach((key, index) => {
      if (index) hash.update(',');
      if (!array) hash.update(JSON.stringify(key) + ':');
      visit((item as { [key: string]: Json })[key]!);
    });
    hash.update(array ? ']' : '}');
  }
  visit(value);
  return hash.digest('hex');
}
export class Repositories {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  identity(): string {
    return transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO identity(singleton,service_id,created_at) VALUES(1,?,?)').run(randomUUID(), new Date().toISOString());
      return String(this.db.prepare('SELECT service_id FROM identity WHERE singleton=1').get()!['service_id']);
    });
  }
  /** All business effects and the replay response commit in one short transaction. */
  replay(scope:string,key:string,body:Json):Json|undefined {
    if(!scope||!key||key.length>256)throw new ServiceError('INVALID_REQUEST','Invalid idempotency scope or key');
    const prior=this.db.prepare('SELECT request_hash,response,invalidated FROM idempotency WHERE scope=? AND key=?').get(scope,key);
    if(!prior)return undefined;
    if(prior['request_hash']!==createHash('sha256').update(canonicalJson(body)).digest('hex'))throw new ServiceError('IDEMPOTENCY_CONFLICT','Idempotency key already used with a different request body');
    if(prior['invalidated'])throw new ServiceError('NOT_FOUND','The graph associated with this request was permanently deleted');
    return JSON.parse(String(prior['response'])) as Json;
  }
  idempotent(scope: string, key: string, body: Json, work: () => Json): Json {
    if (!scope || !key || key.length > 256) throw new ServiceError('INVALID_REQUEST', 'Invalid idempotency scope or key');
    const hash = createHash('sha256').update(canonicalJson(body)).digest('hex');
    return atomic(this.db, () => {
      const prior = this.db.prepare('SELECT request_hash,response,invalidated FROM idempotency WHERE scope=? AND key=?').get(scope,key);
      if (prior) {
        if (prior['request_hash'] !== hash) throw new ServiceError('IDEMPOTENCY_CONFLICT', 'Idempotency key already used with a different request body');
        if(prior['invalidated'])throw new ServiceError('NOT_FOUND','The graph associated with this request was permanently deleted');
        return JSON.parse(String(prior['response'])) as Json;
      }
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Idempotent work must be synchronous');
      this.db.prepare('INSERT INTO idempotency(scope,key,request_hash,response) VALUES(?,?,?,?)').run(scope,key,hash,canonicalJson(result));
      return result;
    });
  }
  setting(key: string): Json | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row['value'])) as Json : undefined;
  }
  /** Internal persistence only; never expose this generic interface as an HTTP route. */
  insert(table: StorageTable, values: Record<string, SQLInputValue>): void {
    const columns = Object.keys(values);
    if (!STORAGE_TABLES.includes(table) || !columns.length || columns.some(key => !/^[a-z_][a-z0-9_]*$/.test(key))) throw new Error('Invalid storage identifier');
    this.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => values[key]!));
  }
  list(table: StorageTable, limit = 100): Record<string, unknown>[] {
    if (!STORAGE_TABLES.includes(table) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid storage query');
    return this.db.prepare(`SELECT * FROM ${table} LIMIT ?`).all(limit);
  }
  appendEvent(event: Omit<ServiceEvent, 'cursor' | 'serviceId'>): string {
    if (!this.db.isTransaction) throw new Error('Events must be persisted inside the business transaction');
    const result = this.db.prepare('INSERT INTO events(id,type,project_id,graph_id,entity_id,revision,occurred_at,payload) VALUES(?,?,?,?,?,?,?,?)').run(event.eventId,event.type,event.projectId,event.graphId,event.entityId,event.revision,event.occurredAt,canonicalJson(event.payload));
    return String(result.lastInsertRowid);
  }
}
export const STORAGE_TABLES = ['sessions','pairing_codes','projects','graphs','nodes','node_versions','edges','blobs','assets','asset_versions','runs','run_notifications','snapshots','outputs','asset_references','events','interactions','occupancy','idempotency','plugin_contracts','backups','canvas_resources','canvas_resource_versions','canvas_resource_references','canvas_outputs','project_file_bindings','project_file_observations','project_file_outputs'] as const;
export type StorageTable = typeof STORAGE_TABLES[number];
