/** Additive workflow storage. Deletion keeps Run identity/FK records as tombstones. */
export const WORKFLOW_SCHEMA = `
ALTER TABLE nodes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1));
CREATE TABLE node_resource_history (
  node_id TEXT NOT NULL, node_version INTEGER NOT NULL, resource_id TEXT NOT NULL, resource_version INTEGER NOT NULL,
  PRIMARY KEY(node_id,node_version,resource_id,resource_version),
  FOREIGN KEY(node_id,node_version) REFERENCES node_versions(node_id,version),
  FOREIGN KEY(resource_id,resource_version) REFERENCES canvas_resource_versions(resource_id,version)
) STRICT;
CREATE TABLE graph_groups (id TEXT PRIMARY KEY,graph_id TEXT NOT NULL REFERENCES graphs(id),run_id TEXT REFERENCES runs(id),title TEXT NOT NULL) STRICT;
CREATE TABLE group_members (group_id TEXT NOT NULL REFERENCES graph_groups(id),node_id TEXT NOT NULL REFERENCES nodes(id),PRIMARY KEY(group_id,node_id)) STRICT;
CREATE TABLE run_runtime (run_id TEXT PRIMARY KEY REFERENCES runs(id),epoch TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,details TEXT NOT NULL CHECK(json_valid(details))) STRICT;
CREATE TABLE run_process_records (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),occurred_at TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE generation_candidates (run_id TEXT PRIMARY KEY REFERENCES runs(id),node_id TEXT NOT NULL REFERENCES nodes(id),base_version INTEGER NOT NULL,content TEXT NOT NULL CHECK(json_valid(content)),state TEXT NOT NULL CHECK(state IN ('pending','accepted','discarded'))) STRICT;
CREATE TABLE publication_manifests (run_id TEXT PRIMARY KEY REFERENCES runs(id),manifest TEXT NOT NULL CHECK(json_valid(manifest)),sha256 TEXT NOT NULL) STRICT;
CREATE TRIGGER immutable_publication_manifest BEFORE UPDATE ON publication_manifests BEGIN SELECT RAISE(ABORT,'publication manifest is immutable'); END;
INSERT INTO settings(key,value) VALUES('eventFloor','0'),('acceptingRuns','true');
`;
