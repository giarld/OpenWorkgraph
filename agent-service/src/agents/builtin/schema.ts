/** Public connection metadata only. Secrets use the private credential store. */
export const BUILTIN_AGENT_SCHEMA = `
CREATE TABLE builtin_agent_connections (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE TABLE builtin_agent_connection_versions (
  connection_id TEXT NOT NULL REFERENCES builtin_agent_connections(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(connection_id,revision)
) STRICT;
CREATE TRIGGER builtin_agent_connection_version_immutable
BEFORE UPDATE ON builtin_agent_connection_versions
BEGIN SELECT RAISE(ABORT,'immutable connection revision'); END;
CREATE TABLE builtin_agent_credential_revocations (
  connection_id TEXT NOT NULL REFERENCES builtin_agent_connections(id),
  credential_namespace TEXT NOT NULL,
  through_revision INTEGER NOT NULL CHECK(through_revision>0),
  PRIMARY KEY(connection_id,credential_namespace)
) STRICT;
`;
