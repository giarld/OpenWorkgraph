/** Additive schema 6 fragment. No legacy resource conversion or file migration. */
export const ASSET_BUSINESS_SCHEMA = `
CREATE TABLE resource_uploads (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0),
 expected_sha256 TEXT, received INTEGER NOT NULL DEFAULT 0 CHECK(received >= 0 AND received <= bytes),
 state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','finished')),
 sha256 TEXT REFERENCES blobs(sha256), created_at INTEGER NOT NULL,
 CHECK((state='finished' AND sha256 IS NOT NULL) OR (state='uploading' AND sha256 IS NULL))
) STRICT;
CREATE TABLE resource_upload_chunks (
 upload_id TEXT NOT NULL REFERENCES resource_uploads(id), offset INTEGER NOT NULL CHECK(offset >= 0),
 bytes INTEGER NOT NULL CHECK(bytes > 0), sha256 TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
 PRIMARY KEY(upload_id,offset)
) STRICT;
CREATE TABLE resource_blob_files (sha256 TEXT PRIMARY KEY REFERENCES blobs(sha256), path TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE resource_file_deletions (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))) STRICT;
CREATE TABLE resource_read_leases (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL REFERENCES blobs(sha256)) STRICT;
CREATE TABLE resource_maintenance_leases (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('backup','drain')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE resource_representations (
 sha256 TEXT NOT NULL REFERENCES blobs(sha256), processor TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
 state TEXT NOT NULL CHECK(state IN ('ready','unsupported','failed')), mime TEXT NOT NULL, text TEXT, reason TEXT,
 PRIMARY KEY(sha256,processor,version)
) STRICT;
CREATE TRIGGER resource_blob_file_immutable BEFORE UPDATE ON resource_blob_files BEGIN SELECT RAISE(ABORT,'immutable blob file'); END;
CREATE TRIGGER resource_asset_ref_reset AFTER UPDATE OF asset_id ON asset_references BEGIN
 UPDATE assets SET unreferenced_since=NULL WHERE id IN (OLD.asset_id,NEW.asset_id);
END;
CREATE TRIGGER resource_no_rebind_deleted_asset BEFORE UPDATE OF asset_id,asset_version ON asset_references
 WHEN (NEW.asset_id!=OLD.asset_id OR NEW.asset_version!=OLD.asset_version) AND (SELECT deleted_at FROM assets WHERE id=NEW.asset_id) IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'deleted assets reject new references'); END;
CREATE TRIGGER resource_output_added AFTER INSERT ON outputs BEGIN UPDATE assets SET unreferenced_since=NULL WHERE id=NEW.asset_id; END;
CREATE TRIGGER resource_output_removed AFTER DELETE ON outputs BEGIN UPDATE assets SET unreferenced_since=NULL WHERE id=OLD.asset_id; END;
CREATE TRIGGER resource_output_changed AFTER UPDATE OF asset_id ON outputs BEGIN UPDATE assets SET unreferenced_since=NULL WHERE id IN (OLD.asset_id,NEW.asset_id); END;
`;
