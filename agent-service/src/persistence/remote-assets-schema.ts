export const REMOTE_ASSETS_SCHEMA = `
CREATE TABLE data_sources (id TEXT PRIMARY KEY, config TEXT NOT NULL CHECK(json_valid(config)), revision INTEGER NOT NULL, location_revision INTEGER NOT NULL, credential_generation TEXT) STRICT;
CREATE TABLE data_source_host_trust (endpoint TEXT PRIMARY KEY, public_key TEXT NOT NULL) STRICT;
CREATE TABLE data_source_host_challenges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE, source_revision INTEGER NOT NULL, endpoint TEXT NOT NULL, public_key TEXT NOT NULL, previous_key TEXT, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE remote_transfers (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), cache_path TEXT, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL) STRICT;
CREATE INDEX remote_transfers_source ON remote_transfers(source_id);
CREATE TABLE remote_temporary_deliveries (id TEXT PRIMARY KEY REFERENCES remote_transfers(id), browser_id TEXT NOT NULL, graph_id TEXT NOT NULL, project_id TEXT NOT NULL, node TEXT NOT NULL CHECK(json_valid(node)), sha256 TEXT NOT NULL REFERENCES blobs(sha256), mime TEXT NOT NULL, name TEXT NOT NULL) STRICT;
CREATE INDEX remote_temporary_deliveries_target ON remote_temporary_deliveries(browser_id,graph_id);
CREATE TABLE remote_temporary_targets (browser_id TEXT NOT NULL, graph_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), writable INTEGER NOT NULL CHECK(writable IN (0,1)), local_revision INTEGER NOT NULL CHECK(local_revision>=0), removed INTEGER NOT NULL CHECK(removed IN (0,1)), PRIMARY KEY(browser_id,graph_id,project_id)) STRICT;
CREATE TABLE remote_resource_provenance (kind TEXT NOT NULL, resource_id TEXT NOT NULL, provenance TEXT NOT NULL CHECK(json_valid(provenance)), PRIMARY KEY(kind,resource_id)) STRICT;
CREATE TRIGGER remote_canvas_provenance_cleanup AFTER DELETE ON canvas_resources BEGIN DELETE FROM remote_resource_provenance WHERE kind='canvas' AND resource_id=OLD.id; END;
CREATE TRIGGER remote_asset_provenance_cleanup AFTER DELETE ON assets BEGIN DELETE FROM remote_resource_provenance WHERE kind='asset' AND resource_id=OLD.id; END;
CREATE TRIGGER remote_delivery_provenance_cleanup AFTER DELETE ON remote_temporary_deliveries BEGIN DELETE FROM remote_resource_provenance WHERE kind='delivery' AND resource_id=OLD.id; END;

`;
