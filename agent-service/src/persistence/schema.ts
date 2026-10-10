import { RESOURCE_SCHEMA } from './resource-schema.js';
import { WORKFLOW_SCHEMA } from './workflow-schema.js';
import { ASSET_BUSINESS_SCHEMA } from './asset-business-schema.js';
import { PLUGIN_SCHEMA } from './plugin-schema.js';
export interface Migration { version: number; sql: string }
export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: `
CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), service_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL) STRICT;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT;
CREATE TABLE sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, browser_name TEXT NOT NULL, paired_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revoked_at INTEGER) STRICT;
CREATE TABLE pairing_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER) STRICT;
CREATE TABLE projects (id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','inactive')), is_git INTEGER NOT NULL CHECK(is_git IN (0,1))) STRICT;
CREATE TABLE graphs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), execution_revision INTEGER NOT NULL DEFAULT 0 CHECK(execution_revision >= 0), layout_revision INTEGER NOT NULL DEFAULT 0 CHECK(layout_revision >= 0), UNIQUE(id,project_id)) STRICT;
CREATE TRIGGER graph_binding_immutable BEFORE UPDATE OF project_id ON graphs WHEN NEW.project_id != OLD.project_id BEGIN SELECT RAISE(ABORT,'graph binding immutable'); END;
CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id), type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0), current_version INTEGER NOT NULL CHECK(current_version > 0), x REAL NOT NULL, y REAL NOT NULL, read_only INTEGER NOT NULL DEFAULT 0 CHECK(read_only IN (0,1)), UNIQUE(id,graph_id), FOREIGN KEY(id,current_version) REFERENCES node_versions(node_id,version) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE node_versions (node_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED, version INTEGER NOT NULL CHECK(version > 0), content TEXT NOT NULL CHECK(json_valid(content)), PRIMARY KEY(node_id,version)) STRICT;
CREATE TRIGGER node_version_immutable BEFORE UPDATE ON node_versions BEGIN SELECT RAISE(ABORT,'immutable node version'); END;
CREATE TABLE edges (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id), source_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reference','delivery')), CHECK(source_id != target_id), UNIQUE(graph_id,source_id,target_id), FOREIGN KEY(source_id,graph_id) REFERENCES nodes(id,graph_id), FOREIGN KEY(target_id,graph_id) REFERENCES nodes(id,graph_id)) STRICT;
CREATE TABLE blobs (sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64), bytes INTEGER NOT NULL CHECK(bytes >= 0)) STRICT;
CREATE TABLE assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)), deleted_at INTEGER, unreferenced_since INTEGER) STRICT;
CREATE TABLE asset_versions (asset_id TEXT NOT NULL REFERENCES assets(id), version INTEGER NOT NULL CHECK(version > 0), sha256 TEXT NOT NULL REFERENCES blobs(sha256), mime TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('processing','ready','failed')), representation_version INTEGER, PRIMARY KEY(asset_id,version)) STRICT;
CREATE TRIGGER asset_version_content_immutable BEFORE UPDATE OF sha256,mime,asset_id,version ON asset_versions BEGIN SELECT RAISE(ABORT,'immutable asset version'); END;
CREATE TABLE runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, graph_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('execution','text_generation','image_generation')), status TEXT NOT NULL CHECK(status IN ('accepted','queued','preparing','running','waiting_answer','waiting_approval','agent_completed','finalizing','cancelling','reconciling','paused_restore','succeeded','failed','cancelled','interrupted')), input_digest TEXT NOT NULL, created_at TEXT NOT NULL, history_state TEXT NOT NULL DEFAULT 'retained' CHECK(history_state IN ('retained','cleared')), FOREIGN KEY(graph_id,project_id) REFERENCES graphs(id,project_id), FOREIGN KEY(node_id,graph_id) REFERENCES nodes(id,graph_id)) STRICT;
CREATE UNIQUE INDEX one_active_run_per_node ON runs(node_id) WHERE status NOT IN ('succeeded','failed','cancelled','interrupted');
CREATE TABLE snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id), input_digest TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TRIGGER snapshot_immutable BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'immutable input snapshot'); END;
CREATE TABLE outputs (run_id TEXT NOT NULL REFERENCES runs(id), output_key TEXT NOT NULL, asset_id TEXT NOT NULL, asset_version INTEGER NOT NULL, node_id TEXT REFERENCES nodes(id), PRIMARY KEY(run_id,output_key), FOREIGN KEY(asset_id,asset_version) REFERENCES asset_versions(asset_id,version)) STRICT;
CREATE TABLE asset_references (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, asset_version INTEGER NOT NULL, node_id TEXT REFERENCES nodes(id), run_id TEXT REFERENCES runs(id), CHECK((node_id IS NOT NULL) != (run_id IS NOT NULL)), FOREIGN KEY(asset_id,asset_version) REFERENCES asset_versions(asset_id,version)) STRICT;
CREATE INDEX asset_reference_version ON asset_references(asset_id,asset_version);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, project_id TEXT REFERENCES projects(id), graph_id TEXT REFERENCES graphs(id), entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), occurred_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE interactions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), epoch TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), kind TEXT NOT NULL CHECK(kind IN ('question','approval')), status TEXT NOT NULL CHECK(status IN ('pending','answered','expired')), payload TEXT NOT NULL CHECK(json_valid(payload)), answer TEXT CHECK(answer IS NULL OR json_valid(answer))) STRICT;
CREATE TABLE occupancy (run_id TEXT PRIMARY KEY REFERENCES runs(id), slot INTEGER NOT NULL UNIQUE CHECK(slot >= 0), project_id TEXT UNIQUE REFERENCES projects(id)) STRICT;
CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)), PRIMARY KEY(scope,key)) STRICT;
CREATE TABLE plugin_contracts (type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0), api_version TEXT NOT NULL, contract TEXT NOT NULL CHECK(json_valid(contract)), PRIMARY KEY(type,schema_version)) STRICT;
CREATE TABLE backups (id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('creating','ready','failed')), created_at TEXT NOT NULL, bytes INTEGER, sha256 TEXT, path TEXT NOT NULL) STRICT;
` }, { version: 2, sql: `
CREATE INDEX runs_project_sequence ON runs(project_id,sequence);
CREATE INDEX events_graph_sequence ON events(graph_id,sequence);
CREATE INDEX sessions_last_used ON sessions(last_used_at);
INSERT INTO settings(key,value) VALUES ('capacity','4'), ('modelDefaults','null');
` }, { version: 3, sql: `
CREATE TABLE trusted_origins (origin TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
ALTER TABLE pairing_codes ADD COLUMN origin TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT '';
` }, { version: 4, sql: RESOURCE_SCHEMA }, { version: 5, sql: WORKFLOW_SCHEMA }, { version: 6, sql: ASSET_BUSINESS_SCHEMA }, { version: 7, sql: PLUGIN_SCHEMA }, { version: 8, sql: `
ALTER TABLE graphs ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN (0,1));
ALTER TABLE idempotency ADD COLUMN invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1));
CREATE TABLE run_file_deletions (run_id TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))) STRICT;
` }, { version: 9, sql: `
ALTER TABLE nodes ADD COLUMN width REAL CHECK(width IS NULL OR (width>0 AND width<=1000000000));
ALTER TABLE nodes ADD COLUMN height REAL CHECK(height IS NULL OR (height>0 AND height<=1000000000));
CREATE TABLE IF NOT EXISTS run_file_deletions (run_id TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))) STRICT;
` }, { version: 10, sql: `
ALTER TABLE pairing_codes ADD COLUMN client_code TEXT;
` }, { version: 11, sql: `
-- Historical nodes have no recoverable creation time. Freeze their insertion
-- order before nodes created after this migration.
ALTER TABLE nodes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0 CHECK(created_at >= 0);
ALTER TABLE nodes ADD COLUMN creation_order INTEGER NOT NULL DEFAULT 0 CHECK(creation_order >= 0);
UPDATE nodes SET creation_order=rowid;
CREATE UNIQUE INDEX nodes_creation_order ON nodes(creation_order);
CREATE INDEX nodes_graph_creation ON nodes(graph_id,created_at,creation_order);
` }, { version: 12, sql: `
CREATE TABLE image_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, driver TEXT NOT NULL CHECK(driver IN ('openai')), endpoint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision > 0), credential_revision INTEGER, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))) STRICT;
CREATE TABLE image_provider_models (provider_id TEXT NOT NULL REFERENCES image_providers(id), id TEXT NOT NULL, name TEXT NOT NULL, modes TEXT NOT NULL CHECK(json_valid(modes)), formats TEXT NOT NULL CHECK(json_valid(formats)), sizes TEXT NOT NULL CHECK(json_valid(sizes)), qualities TEXT NOT NULL CHECK(json_valid(qualities)), is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)), verified_at TEXT, PRIMARY KEY(provider_id,id)) STRICT;
CREATE UNIQUE INDEX image_provider_default_model ON image_provider_models(provider_id) WHERE is_default=1;
` }, { version: 13, sql: `
CREATE TABLE image_provider_config_versions (provider_id TEXT NOT NULL REFERENCES image_providers(id), revision INTEGER NOT NULL CHECK(revision > 0), payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(provider_id,revision)) STRICT;
CREATE TRIGGER image_provider_config_immutable BEFORE UPDATE ON image_provider_config_versions BEGIN SELECT RAISE(ABORT,'immutable image provider configuration'); END;
INSERT INTO image_provider_config_versions(provider_id,revision,payload)
SELECT p.id,p.revision,json_object('endpoint',p.endpoint,'driver',p.driver,'models',
  coalesce((SELECT json_group_array(json_object('id',m.id,'name',m.name,'modes',json(m.modes),'formats',json(m.formats),'sizes',json(m.sizes),'qualities',json(m.qualities),'isDefault',json(m.is_default)))
  FROM image_provider_models m WHERE m.provider_id=p.id),json('[]')))
FROM image_providers p;
` }, { version: 14, sql: `
ALTER TABLE image_providers ADD COLUMN credential_counter INTEGER NOT NULL DEFAULT 0 CHECK(credential_counter >= 0);
UPDATE image_providers SET credential_counter=coalesce(credential_revision,0);
CREATE TABLE image_provider_revoked_credentials (provider_id TEXT NOT NULL REFERENCES image_providers(id), revision INTEGER NOT NULL CHECK(revision > 0), PRIMARY KEY(provider_id,revision)) STRICT;
` }, { version: 15, sql: `
ALTER TABLE nodes ADD COLUMN undo_expires_at INTEGER;
CREATE INDEX nodes_undo_expiry ON nodes(undo_expires_at) WHERE undo_expires_at IS NOT NULL;
` }, { version: 16, sql: `
CREATE TABLE execution_outputs (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  execution_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  CHECK(node_id != execution_node_id)
) STRICT;
CREATE INDEX execution_outputs_owner ON execution_outputs(execution_node_id);
-- Infer only service originals backed by an execution Run.
INSERT INTO execution_outputs(node_id,execution_node_id)
SELECT n.id,r.node_id FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version
JOIN runs r ON r.id=json_extract(v.content,'$.runId') AND r.graph_id=n.graph_id AND r.kind='execution'
JOIN nodes owner ON owner.id=r.node_id AND owner.deleted=0
WHERE n.deleted=0 AND n.read_only_reason='original' AND n.id!=r.node_id;
INSERT OR IGNORE INTO execution_outputs(node_id,execution_node_id)
SELECT e.target_id,e.source_id FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id
WHERE e.kind='delivery' AND s.type='execution' AND s.deleted=0 AND t.deleted=0;
-- Only remove legacy artifact-to-artifact references within the same Run.
DELETE FROM edges WHERE id IN (
 SELECT e.id FROM edges e JOIN execution_outputs s ON s.node_id=e.source_id
 JOIN execution_outputs t ON t.node_id=e.target_id AND t.execution_node_id=s.execution_node_id
 JOIN nodes sn ON sn.id=s.node_id JOIN node_versions sv ON sv.node_id=sn.id AND sv.version=sn.current_version
 JOIN nodes tn ON tn.id=t.node_id JOIN node_versions tv ON tv.node_id=tn.id AND tv.version=tn.current_version
 WHERE e.kind='reference' AND sn.type='document' AND tn.type='image'
 AND sn.read_only_reason='original' AND tn.read_only_reason='original'
 AND json_extract(sv.content,'$.mime')='text/markdown'
 AND json_extract(sv.content,'$.runId')=json_extract(tv.content,'$.runId')
);
INSERT INTO edges(id,graph_id,source_id,target_id,kind)
SELECT 'output-'||lower(hex(randomblob(16))),n.graph_id,o.execution_node_id,o.node_id,'delivery'
FROM execution_outputs o JOIN nodes n ON n.id=o.node_id
WHERE NOT EXISTS(SELECT 1 FROM edges e WHERE e.source_id=o.execution_node_id AND e.target_id=o.node_id);
CREATE TRIGGER register_execution_output AFTER INSERT ON edges WHEN NEW.kind='delivery'
BEGIN INSERT INTO execution_outputs(node_id,execution_node_id) VALUES(NEW.target_id,NEW.source_id)
ON CONFLICT(node_id) DO UPDATE SET execution_node_id=excluded.execution_node_id; END;
UPDATE graphs SET execution_revision=execution_revision+1 WHERE id IN
(SELECT n.graph_id FROM execution_outputs o JOIN nodes n ON n.id=o.node_id);
UPDATE idempotency SET invalidated=1 WHERE scope LIKE '%:graph.command:%';
` }, { version: 17, sql: `
CREATE TABLE project_file_bindings (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  relative_path TEXT NOT NULL CHECK(relative_path != ''),
  UNIQUE(project_id,relative_path,node_id)
) STRICT;
CREATE INDEX project_file_bindings_path ON project_file_bindings(project_id,relative_path);
CREATE TABLE project_file_observations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL CHECK(relative_path != ''),
  state TEXT NOT NULL CHECK(state IN ('available','missing','unavailable')),
  name TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER CHECK(bytes IS NULL OR bytes >= 0),
  change_token TEXT,
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY(project_id,relative_path)
) STRICT;
CREATE TABLE project_file_outputs (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  output_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  relative_path TEXT NOT NULL CHECK(relative_path != ''),
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  PRIMARY KEY(run_id,output_key),
  UNIQUE(run_id,relative_path)
) STRICT;
CREATE INDEX project_file_outputs_path ON project_file_outputs(project_id,relative_path);

-- Keep the current-source index correct for every writer of node_versions,
-- including imports, generation acceptance, undo/restore and future commands.
CREATE TRIGGER project_file_binding_on_version_insert AFTER INSERT ON node_versions
WHEN (SELECT current_version FROM nodes WHERE id=NEW.node_id)=NEW.version
BEGIN
  DELETE FROM project_file_bindings WHERE node_id=NEW.node_id;
  INSERT INTO project_file_bindings(node_id,service_id,project_id,relative_path)
  SELECT NEW.node_id,json_extract(NEW.content,'$.source.serviceId'),json_extract(NEW.content,'$.source.projectId'),json_extract(NEW.content,'$.source.relativePath')
  WHERE json_extract(NEW.content,'$.source.kind')='project-file';
END;
CREATE TRIGGER project_file_binding_on_current_version AFTER UPDATE OF current_version ON nodes
BEGIN
  DELETE FROM project_file_bindings WHERE node_id=NEW.id;
  INSERT INTO project_file_bindings(node_id,service_id,project_id,relative_path)
  SELECT NEW.id,json_extract(v.content,'$.source.serviceId'),json_extract(v.content,'$.source.projectId'),json_extract(v.content,'$.source.relativePath')
  FROM node_versions v WHERE v.node_id=NEW.id AND v.version=NEW.current_version
    AND json_extract(v.content,'$.source.kind')='project-file';
END;
INSERT INTO project_file_bindings(node_id,service_id,project_id,relative_path)
SELECT n.id,json_extract(v.content,'$.source.serviceId'),json_extract(v.content,'$.source.projectId'),json_extract(v.content,'$.source.relativePath')
FROM nodes n JOIN node_versions v ON v.node_id=n.id AND v.version=n.current_version
JOIN graphs g ON g.id=n.graph_id
WHERE json_extract(v.content,'$.source.kind')='project-file'
  AND json_extract(v.content,'$.source.projectId')=g.project_id;
` }, { version: 18, sql: `
CREATE TABLE edges_next (id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES graphs(id), source_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reference','execution','delivery')), CHECK(source_id != target_id), UNIQUE(graph_id,source_id,target_id), FOREIGN KEY(source_id,graph_id) REFERENCES nodes(id,graph_id), FOREIGN KEY(target_id,graph_id) REFERENCES nodes(id,graph_id)) STRICT;
INSERT INTO edges_next SELECT * FROM edges;
DROP TRIGGER register_execution_output;
DROP TABLE edges;
ALTER TABLE edges_next RENAME TO edges;
CREATE INDEX execution_edges_source ON edges(graph_id,source_id) WHERE kind='execution';
CREATE TRIGGER register_execution_output AFTER INSERT ON edges WHEN NEW.kind='delivery'
BEGIN INSERT INTO execution_outputs(node_id,execution_node_id) VALUES(NEW.target_id,NEW.source_id)
ON CONFLICT(node_id) DO UPDATE SET execution_node_id=excluded.execution_node_id; END;
` }, { version: 19, sql: `
CREATE TABLE execution_input_snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id),payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TRIGGER execution_input_snapshot_immutable BEFORE UPDATE ON execution_input_snapshots BEGIN SELECT RAISE(ABORT,'immutable execution input snapshot'); END;
` }, { version: 20, sql: `
CREATE TABLE run_notifications (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed','waiting_answer','waiting_approval','interrupted')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  read_at TEXT
) STRICT;
CREATE INDEX run_notifications_unread ON run_notifications(read_at,created_at) WHERE read_at IS NULL;
INSERT INTO run_notifications(run_id,status,revision,created_at,read_at)
SELECT id,status,1,created_at,NULL FROM runs WHERE status IN ('waiting_answer','waiting_approval');
` }, { version: 21, sql: `
UPDATE settings SET value='4' WHERE key='capacity' AND value='2';
` }, { version: 22, sql: `
CREATE TABLE graph_document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX graph_document_versions_graph ON graph_document_versions(graph_id,id);
CREATE TABLE graph_document_heads (
  graph_id TEXT PRIMARY KEY REFERENCES graphs(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL REFERENCES graph_document_versions(id),
  execution_revision INTEGER NOT NULL,
  layout_revision INTEGER NOT NULL,
  run_sequence INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE graph_document_resources (
  version_id INTEGER NOT NULL REFERENCES graph_document_versions(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  PRIMARY KEY(version_id,resource_id,resource_version),
  FOREIGN KEY(resource_id,resource_version) REFERENCES canvas_resource_versions(resource_id,version)
) STRICT;
CREATE INDEX graph_document_resources_resource ON graph_document_resources(resource_id);
` }, { version: 23, sql: `
ALTER TABLE graphs ADD COLUMN updated_at TEXT;
UPDATE graphs SET updated_at=(SELECT MAX(occurred_at) FROM events WHERE graph_id=graphs.id AND type='graph.changed');
CREATE TRIGGER graph_modified_at AFTER INSERT ON events WHEN NEW.type='graph.changed' AND NEW.graph_id IS NOT NULL
BEGIN UPDATE graphs SET updated_at=NEW.occurred_at WHERE id=NEW.graph_id; END;
` }, { version: 24, sql: `
CREATE TABLE graph_document_run_gates (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL REFERENCES graph_document_versions(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX graph_document_run_gates_cursor ON graph_document_run_gates(graph_id,cursor);
` }, { version: 25, sql: `
CREATE TABLE launch_input_snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TRIGGER launch_input_snapshot_immutable BEFORE UPDATE ON launch_input_snapshots BEGIN SELECT RAISE(ABORT,'immutable launch input snapshot'); END;
` }, { version: 26, sql: `
CREATE TEMP TABLE visualize_run_sequence AS SELECT seq FROM sqlite_sequence WHERE name='runs';
CREATE TABLE runs_visualize (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, graph_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('execution','text_generation','image_generation','visualize_generation')), status TEXT NOT NULL CHECK(status IN ('accepted','queued','preparing','running','waiting_answer','waiting_approval','agent_completed','finalizing','cancelling','reconciling','paused_restore','succeeded','failed','cancelled','interrupted')), input_digest TEXT NOT NULL, created_at TEXT NOT NULL, history_state TEXT NOT NULL DEFAULT 'retained' CHECK(history_state IN ('retained','cleared')), FOREIGN KEY(graph_id,project_id) REFERENCES graphs(id,project_id), FOREIGN KEY(node_id,graph_id) REFERENCES nodes(id,graph_id)) STRICT;
INSERT INTO runs_visualize SELECT * FROM runs;
PRAGMA legacy_alter_table=ON;
DROP TABLE runs;
ALTER TABLE runs_visualize RENAME TO runs;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM visualize_run_sequence),0)) WHERE name='runs';
INSERT INTO sqlite_sequence(name,seq) SELECT 'runs',seq FROM visualize_run_sequence WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='runs');
DROP TABLE visualize_run_sequence;
PRAGMA legacy_alter_table=OFF;
CREATE UNIQUE INDEX one_active_run_per_node ON runs(node_id) WHERE status NOT IN ('succeeded','failed','cancelled','interrupted');
CREATE INDEX runs_project_sequence ON runs(project_id,sequence);
CREATE UNIQUE INDEX runs_id_graph ON runs(id,graph_id);
` }];
export const SCHEMA_VERSION = 26;
