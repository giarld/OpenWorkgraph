/** Remote assets are Workspace operations, independent of Agent Runs. */
export type DataSourceConfig = { name: string; root: string } & (
  { kind: 'git'; url: string; branch: string; auth: 'public' | 'token' | 'key' } |
  { kind: 'sftp'; host: string; port: number; username: string; auth: 'password' | 'key' }
);
/** Write only. Omitted fields retain their value; null removes it. */
export interface DataSourceCredentials { token?: string | null; password?: string | null; passphrase?: string | null }
export interface DataSource { id: string; serviceId: string; revision: number; locationRevision: number; config: DataSourceConfig; credentials: { token: boolean; password: boolean; passphrase: boolean }; busy: boolean }
export interface RemoteEntry { name: string; path: string; kind: 'file' | 'directory' | 'unavailable'; bytes: number | null; error?: string }
export interface RemoteListing { serviceId: string; sourceId: string; locationRevision: number; path: string; entries: RemoteEntry[]; observedAt: string }
export type RemoteFileVersion = { kind: 'git'; commit: string; blob: string; sha256: string; bytes: number } | { kind: 'sftp'; sha256: string; bytes: number };
export interface HostTrustChallenge { id: string; endpoint: string; fingerprint: string; previousFingerprint: string | null; expiresAt: string }
export type RemoteTransferTarget = { kind: 'library'; projectId: string } | { kind: 'graph'; projectId: string; graphId: string; x: number; y: number } | { kind: 'temporary'; projectId: string; browserId: string; graphId: string; x: number; y: number };
export type RemoteTransferState = 'accepted' | 'preparing' | 'transferring' | 'committing' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface RemoteTransfer { id: string; serviceId: string; sourceId: string; sourceName: string; locationRevision: number; path: string; target: RemoteTransferTarget; state: RemoteTransferState; attempt: number; revision: number; received: number; bytes: number | null; version: RemoteFileVersion | null; createdAt: string; updatedAt: string; error: string | null; retryable: boolean; retryBlockedReason?: string; result: { assetId?: string; resourceId?: string; nodeId?: string; deliveryId?: string; deliveryAcknowledged?: boolean } | null }
export interface RemoteTransferRequest { idempotencyKey: string; sourceId: string; locationRevision: number; path: string; target: RemoteTransferTarget }
export interface RemoteProvenance { sourceName: string; relativePath: string; importedAt: string; commit?: string }
