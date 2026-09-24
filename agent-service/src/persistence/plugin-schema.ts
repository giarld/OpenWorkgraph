/** Additive schema7, wired by the main migration owner.
 * Backfill is valid for the pre-plugin-management lineage: no node schema
 * migration API could run before this table existed (it fails closed). Existing
 * imported nodes may use schema >1, but all their retained versions use that
 * same schema. A database with out-of-band historical schema mutations needs
 * explicit recovery metadata; this migration cannot infer those mutations.
 * Ambiguous preexisting read_only rows stay original, never auto-unlocked.
 */
export const PLUGIN_SCHEMA = `
ALTER TABLE nodes ADD COLUMN read_only_reason TEXT NOT NULL DEFAULT 'none'
  CHECK(read_only_reason IN ('none','missing_plugin','original'));
UPDATE nodes SET read_only_reason='original' WHERE read_only=1;
CREATE TABLE node_version_schemas (
  node_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  PRIMARY KEY(node_id,version),
  FOREIGN KEY(node_id,version) REFERENCES node_versions(node_id,version) ON DELETE CASCADE
) STRICT;
INSERT INTO node_version_schemas(node_id,version,schema_version)
  SELECT v.node_id,v.version,n.schema_version FROM node_versions v JOIN nodes n ON n.id=v.node_id;
CREATE TRIGGER node_version_schema_capture AFTER INSERT ON node_versions BEGIN
  INSERT INTO node_version_schemas(node_id,version,schema_version)
    SELECT NEW.node_id,NEW.version,schema_version FROM nodes WHERE id=NEW.node_id;
END;
CREATE TRIGGER node_version_schema_immutable BEFORE UPDATE ON node_version_schemas BEGIN
  SELECT RAISE(ABORT,'immutable node version schema');
END;
CREATE TRIGGER node_version_schema_delete_guard BEFORE DELETE ON node_version_schemas
WHEN EXISTS(SELECT 1 FROM node_versions WHERE node_id=OLD.node_id AND version=OLD.version) BEGIN
  SELECT RAISE(ABORT,'retained node version requires schema history');
END;
CREATE TRIGGER node_current_schema_guard BEFORE UPDATE OF schema_version,current_version ON nodes
WHEN EXISTS(SELECT 1 FROM node_version_schemas s WHERE s.node_id=NEW.id AND s.version=NEW.current_version AND s.schema_version!=NEW.schema_version) BEGIN
  SELECT RAISE(ABORT,'current node schema does not match version history');
END;
`;
