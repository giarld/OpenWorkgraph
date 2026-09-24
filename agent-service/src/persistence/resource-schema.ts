/** Additive only: legacy asset references, outputs and snapshot JSON are preserved. */
export const RESOURCE_SCHEMA = `
ALTER TABLE assets ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version >= 0);
UPDATE assets SET current_version=COALESCE((SELECT MAX(version) FROM asset_versions WHERE asset_id=assets.id),0);
CREATE INDEX assets_project_name ON assets(project_id,name);
CREATE UNIQUE INDEX runs_id_graph ON runs(id,graph_id);
CREATE TABLE canvas_resources (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, graph_id TEXT NOT NULL, name TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK(current_version > 0), UNIQUE(id,graph_id),
  FOREIGN KEY(graph_id,project_id) REFERENCES graphs(id,project_id),
  FOREIGN KEY(id,current_version) REFERENCES canvas_resource_versions(resource_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE canvas_resource_versions (
  resource_id TEXT NOT NULL REFERENCES canvas_resources(id) DEFERRABLE INITIALLY DEFERRED,
  version INTEGER NOT NULL CHECK(version > 0), sha256 TEXT NOT NULL REFERENCES blobs(sha256), mime TEXT NOT NULL,
  representation_version INTEGER, PRIMARY KEY(resource_id,version)
) STRICT;
CREATE TRIGGER canvas_version_immutable BEFORE UPDATE ON canvas_resource_versions BEGIN SELECT RAISE(ABORT,'immutable canvas resource version'); END;
CREATE TRIGGER canvas_binding_immutable BEFORE UPDATE OF project_id,graph_id ON canvas_resources WHEN NEW.project_id != OLD.project_id OR NEW.graph_id != OLD.graph_id BEGIN SELECT RAISE(ABORT,'canvas resource binding immutable'); END;
CREATE TABLE canvas_resource_references (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, resource_version INTEGER NOT NULL, graph_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('graph','node','snapshot','history')),
  node_id TEXT, run_id TEXT,
  CHECK((owner_kind='graph' AND node_id IS NULL AND run_id IS NULL) OR (owner_kind='node' AND node_id IS NOT NULL AND run_id IS NULL) OR (owner_kind IN ('snapshot','history') AND node_id IS NULL AND run_id IS NOT NULL)),
  FOREIGN KEY(resource_id,resource_version) REFERENCES canvas_resource_versions(resource_id,version),
  FOREIGN KEY(resource_id,graph_id) REFERENCES canvas_resources(id,graph_id),
  FOREIGN KEY(node_id,graph_id) REFERENCES nodes(id,graph_id),
  FOREIGN KEY(run_id,graph_id) REFERENCES runs(id,graph_id)
) STRICT;
CREATE INDEX canvas_refs_resource ON canvas_resource_references(resource_id,resource_version);
CREATE TRIGGER frozen_resource_reference_immutable BEFORE UPDATE ON canvas_resource_references WHEN OLD.owner_kind IN ('snapshot','history') BEGIN SELECT RAISE(ABORT,'frozen resource reference'); END;
CREATE TABLE canvas_outputs (
  run_id TEXT NOT NULL, graph_id TEXT NOT NULL, output_key TEXT NOT NULL, resource_id TEXT NOT NULL, resource_version INTEGER NOT NULL,
  PRIMARY KEY(run_id,output_key), FOREIGN KEY(resource_id,resource_version) REFERENCES canvas_resource_versions(resource_id,version),
  FOREIGN KEY(resource_id,graph_id) REFERENCES canvas_resources(id,graph_id), FOREIGN KEY(run_id,graph_id) REFERENCES runs(id,graph_id)
) STRICT;
CREATE TRIGGER no_new_canvas_asset_link BEFORE INSERT ON asset_references WHEN NEW.node_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'canvas nodes must use independent canvas resources'); END;
CREATE TRIGGER no_rebind_canvas_asset_link BEFORE UPDATE OF asset_id,asset_version,node_id ON asset_references WHEN NEW.node_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'legacy canvas asset references cannot be rebound'); END;
CREATE TRIGGER no_new_deleted_asset_reference BEFORE INSERT ON asset_references WHEN (SELECT deleted_at FROM assets WHERE id=NEW.asset_id) IS NOT NULL BEGIN SELECT RAISE(ABORT,'deleted assets reject new references'); END;
CREATE TRIGGER asset_reference_added AFTER INSERT ON asset_references BEGIN UPDATE assets SET unreferenced_since=NULL WHERE id=NEW.asset_id; END;
CREATE TRIGGER asset_reference_removed AFTER DELETE ON asset_references BEGIN UPDATE assets SET unreferenced_since=NULL WHERE id=OLD.asset_id; END;
`;
