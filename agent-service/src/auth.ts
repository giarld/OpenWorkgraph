import { createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClientPairingStatus, PairRequest, PairResponse, Session } from '@openworkgraph/protocol';
import { PAIR_AUTHORIZATION_PREFIX, encodePairAuthorization, parsePairAuthorization, normalizeShortPairingCode, formatShortPairingCode } from '@openworkgraph/protocol';
import { inspectClientCode, requirePairingProof } from './client-pairing.js';
import { ServiceError } from './errors.js';
import { transaction } from './persistence/database.js';
import { Repositories } from './persistence/repositories.js';

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
type SessionRow = { id: string; browser_name: string; origin: string; paired_at: number; last_used_at: number; revoked_at: number | null };
export function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*') || url.pathname !== '/' || url.search || url.hash || url.origin === 'null') throw new Error();
    return url.origin;
  } catch { throw new ServiceError('ORIGIN_DENIED', '网页来源必须是完整的 http(s)://主机:端口，不含路径、账号、查询或通配符。'); }
}
export class Auth {
  private pendingClients = new Map<string, { clientCode: string; expiresAt: number; approvedAt?: number; browserName?: string; response?: PairResponse; completedAt?: number }>();
  private shortAttempts = new Map<string, { count: number; expiresAt: number }>();
  private prunePairingRequests() {
    for (const [key, value] of this.pendingClients) if (value.expiresAt <= this.now()) this.pendingClients.delete(key);
    for (const [key, value] of this.shortAttempts) if (value.expiresAt <= this.now()) this.shortAttempts.delete(key);
  }
  /** Public registration grants no trust. Only the local control channel can resolve/approve it. */
  requestClientPairing(clientCode: string, origin: string) {
    const { client } = inspectClientCode(clientCode);
    if (client.origin !== origin) throw new ServiceError('ORIGIN_DENIED', '客户端来源与当前网页不匹配。');
    this.prunePairingRequests();
    for (const [code, pending] of this.pendingClients) if (pending.clientCode === clientCode) return { code: formatShortPairingCode(code), expiresAt: new Date(pending.expiresAt).toISOString(), serviceId: this.serviceId };
    if (this.pendingClients.size >= 100) throw new ServiceError('INVALID_REQUEST', '待配对请求过多，请五分钟后重试。');
    let code: string;
    do { code = randomInt(100_000_000).toString().padStart(8, '0'); } while (this.pendingClients.has(code));
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pendingClients.set(code, { clientCode, expiresAt });
    return { code: formatShortPairingCode(code), expiresAt: new Date(expiresAt).toISOString(), serviceId: this.serviceId };
  }
  resolveClientPairing(code: string): string {
    this.prunePairingRequests();
    const pending = this.pendingClients.get(normalizeShortPairingCode(code) ?? '');
    if (!pending) throw new ServiceError('PAIRING_CODE_INVALID', '客户端码无效或已过期，请在浏览器重新生成。');
    return pending.clientCode;
  }
  approveClientPairing(code: string, clientCode: string) {
    if (this.resolveClientPairing(code) !== clientCode) throw new ServiceError('PAIRING_CODE_INVALID', '客户端请求已变化，请重新确认。');
    const requestCode = normalizeShortPairingCode(code)!;
    const pending = this.pendingClients.get(requestCode)!;
    const { client, fingerprint } = inspectClientCode(clientCode);
    const origin = normalizeOrigin(client.origin);
    const approvedAt = this.now();
    pending.approvedAt = approvedAt;
    return { status: 'approved', origin, fingerprint, expiresAt: new Date(pending.expiresAt).toISOString(), serviceId: this.serviceId };
  }
  claimClientPairing(input: PairRequest, origin: string): ClientPairingStatus {
    if (input.expectedServiceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', '服务身份不一致，请核对客户端码对应的运行时。');
    if (typeof input.browserName !== 'string' || !input.browserName.trim() || input.browserName.trim().length > 100 || /[\x00-\x1f\x7f]/.test(input.browserName)) throw new ServiceError('INVALID_REQUEST', '浏览器名称必须为 1～100 个字符，不能包含控制字符。');
    const code = typeof input.code === 'string' ? normalizeShortPairingCode(input.code) : undefined;
    if (!code || typeof input.clientCode !== 'string') throw new ServiceError('PAIRING_CODE_INVALID', '客户端码无效，请在浏览器重新生成。');
    this.prunePairingRequests();
    const pending = this.pendingClients.get(code);
    if (!pending || pending.clientCode !== input.clientCode) throw new ServiceError('PAIRING_CODE_INVALID', '客户端码无效或已过期，请在浏览器重新生成。');
    const inspected = inspectClientCode(input.clientCode);
    if (inspected.client.origin !== origin) throw new ServiceError('ORIGIN_DENIED', '客户端来源与当前网页不匹配。');
    requirePairingProof(input.clientCode, input.proof, this.serviceId, origin, input.code, input.browserName);
    if (!pending.approvedAt) return { status: 'pending', expiresAt: new Date(pending.expiresAt).toISOString(), serviceId: this.serviceId };
    if (pending.response) {
      if (pending.browserName !== input.browserName.trim()) throw new ServiceError('PAIRING_CODE_INVALID', '客户端名称与已领取的会话不匹配。');
      return { status: pending.completedAt ? 'paired' : 'ready', expiresAt: new Date(pending.expiresAt).toISOString(), ...pending.response };
    }
    const now = this.now();
    const token = 'wg1_' + randomBytes(32).toString('base64url');
    const id = randomUUID();
    const browserName = input.browserName.trim();
    const response = { serviceId: this.serviceId, token, session: this.toSession({ id, browser_name: browserName, paired_at: now, last_used_at: now, revoked_at: null, origin }, id) };
    pending.browserName = browserName;
    pending.response = response;
    return { status: 'ready', expiresAt: new Date(pending.expiresAt).toISOString(), ...response };
  }
  completeClientPairing(codeInput: string, expectedServiceId: string, token: string, origin: string): ClientPairingStatus {
    if (expectedServiceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', '服务身份不一致，请核对客户端码对应的运行时。');
    const code = normalizeShortPairingCode(codeInput);
    this.prunePairingRequests();
    const pending = code ? this.pendingClients.get(code) : undefined;
    if (!pending?.approvedAt || !pending.response || inspectClientCode(pending.clientCode).client.origin !== origin || this.hash('session', token) !== this.hash('session', pending.response.token))
      throw new ServiceError('PAIRING_CODE_INVALID', '配对握手无效或已过期，请重新生成客户端码。');
    if (!pending.completedAt) {
      const session = pending.response.session;
      transaction(this.db, () => {
        this.db.prepare('INSERT OR IGNORE INTO trusted_origins(origin,created_at) VALUES(?,?)').run(origin, pending.approvedAt!);
        this.db.prepare('INSERT INTO sessions(id,token_hash,browser_name,paired_at,last_used_at,origin) VALUES(?,?,?,?,?,?)').run(session.id, this.hash('session', token), session.browserName, Date.parse(session.pairedAt), Date.parse(session.lastUsedAt), origin);
      });
      pending.completedAt = this.now();
    }
    return { status: 'paired', ...pending.response };
  }
  constructor(readonly db: DatabaseSync, readonly serviceId: string, readonly now: () => number = Date.now) {}
  private hash(kind: string, value: string): string { return createHash('sha256').update(this.serviceId + ':' + kind + ':' + value).digest('hex'); }
  /** Local-only authority. Never route issuance through the network API. */
  issueCode(originInput: string): { code: string; origin: string; expiresAt: string; serviceId: string } {
    const origin = normalizeOrigin(originInput);
    const code = randomBytes(16).toString('hex').toUpperCase();
    const now = this.now();
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO trusted_origins(origin,created_at) VALUES(?,?)').run(origin,now);
      this.db.prepare('INSERT INTO pairing_codes(code_hash,expires_at,origin) VALUES(?,?,?)').run(this.hash('pair',code),now + PAIRING_TTL_MS,origin);
    });
    return { code: code.match(/.{8}/g)!.join('-'), origin, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(), serviceId: this.serviceId };
  }
  /** Local authorization only. A bound grant can never use the legacy exchange. */
  issueClientCode(clientCode: string, short = false) {
    const { client, fingerprint, clientHash } = inspectClientCode(clientCode);
    const origin = normalizeOrigin(client.origin), now = this.now();
    const secret = short ? randomInt(100_000_000).toString().padStart(8, '0') : randomBytes(16).toString('hex').toUpperCase();
    const expiresAt = now + PAIRING_TTL_MS;
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO trusted_origins(origin,created_at) VALUES(?,?)').run(origin, now);
      if (short) this.db.prepare('DELETE FROM pairing_codes WHERE client_code=?').run(clientCode);
      this.db.prepare('INSERT INTO pairing_codes(code_hash,expires_at,origin,client_code) VALUES(?,?,?,?)').run(this.hash('pair', short ? clientHash + ':' + secret : secret), expiresAt, origin, clientCode);
    });
    this.shortAttempts.delete(clientHash);
    return { code: short ? formatShortPairingCode(secret) : encodePairAuthorization({ version: 1, serviceId: this.serviceId, code: secret, clientHash, expiresAt }), origin, fingerprint, expiresAt: new Date(expiresAt).toISOString(), serviceId: this.serviceId };
  }
  requireOrigin(origin: string | undefined): string {
    if (!origin || normalizeOrigin(origin) !== origin || !this.db.prepare('SELECT 1 FROM trusted_origins WHERE origin=?').get(origin)) throw new ServiceError('ORIGIN_DENIED', '此客户端来源尚未由本机授权；请先在浏览器生成客户端码，再在服务设备运行 pair --client-code 后重试。');
    return origin;
  }
  pair(input: PairRequest, origin: string): PairResponse {
    this.requireOrigin(origin);
    if (input.expectedServiceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', '服务身份不一致，请核对本机命令输出的 serviceId 和地址。');
    if (typeof input.browserName !== 'string' || !input.browserName.trim() || input.browserName.trim().length > 100 || /[\x00-\x1f\x7f]/.test(input.browserName)) throw new ServiceError('INVALID_REQUEST', '浏览器名称必须为 1～100 个字符，不能包含控制字符。');
    let grant: ReturnType<typeof parsePairAuthorization> | undefined;
    const short = typeof input.code === 'string' ? normalizeShortPairingCode(input.code) : undefined;
    let shortHash: string | undefined;
    if (short) {
      if (typeof input.clientCode !== 'string') throw new ServiceError('PAIRING_CODE_INVALID', '请在生成客户端码的原页面配对。');
      // Verify possession before counting attempts, so strangers cannot lock out a client.
      requirePairingProof(input.clientCode, input.proof, this.serviceId, origin, input.code, input.browserName);
      const clientHash = inspectClientCode(input.clientCode).clientHash;
      this.prunePairingRequests();
      let attempts = this.shortAttempts.get(clientHash);
      if (!attempts) {
        if (this.shortAttempts.size >= 1000) throw new ServiceError('PAIRING_CODE_INVALID', '配对请求过多，请稍后重试。');
        attempts = { count: 0, expiresAt: this.now() + PAIRING_TTL_MS };
        this.shortAttempts.set(clientHash, attempts);
      }
      if (attempts.count >= 5) throw new ServiceError('PAIRING_CODE_INVALID', '尝试次数过多，请重新生成客户端码并在服务设备授权。');
      attempts.count++;
      shortHash = this.hash('pair', clientHash + ':' + short);
    }
    if (typeof input.code === 'string' && input.code.startsWith(PAIR_AUTHORIZATION_PREFIX)) {
      try { grant = parsePairAuthorization(input.code); } catch { throw new ServiceError('PAIRING_CODE_INVALID', '配对授权码无效，请复制完整授权码。'); }
      if (grant.serviceId !== this.serviceId) throw new ServiceError('SERVICE_MISMATCH', '授权码属于其他服务。');
    } else if (!short && (typeof input.code !== 'string' || !/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{8}){3})$/.test(input.code))) throw new ServiceError('PAIRING_CODE_INVALID', '配对码无效，请输入 8 位数字。');
    const hash = shortHash ?? this.hash('pair', grant?.code ?? input.code.replaceAll('-','').toUpperCase());
    return transaction(this.db, () => {
      const code = this.db.prepare('SELECT expires_at,consumed_at,origin,client_code FROM pairing_codes WHERE code_hash=?').get(hash);
      const now = this.now();
      if (!code) throw new ServiceError('PAIRING_CODE_INVALID', '配对码无效，请在目标服务设备重新获取。');
      if (code['origin'] !== origin) throw new ServiceError('ORIGIN_DENIED', '配对码绑定了其他网页来源，请按当前网页来源重新获取。');
      if (code['consumed_at'] !== null) throw new ServiceError('PAIRING_CODE_USED', '配对码已兑换；若浏览器未保存成功，请在服务设备重新获取配对码。');
      if (now >= Number(code['expires_at'])) throw new ServiceError('PAIRING_CODE_EXPIRED', '配对码已超过 5 分钟，请在服务设备重新获取。');
      if (code['client_code'] !== null) {
        if (typeof input.clientCode !== 'string' || input.clientCode !== code['client_code'] || (!short && (!grant || grant.expiresAt !== code['expires_at'] || grant.clientHash !== inspectClientCode(input.clientCode).clientHash))) throw new ServiceError('PAIRING_CODE_INVALID', '授权码与此客户端不匹配；不能降级兑换，请在原页面重试。');
        requirePairingProof(input.clientCode, input.proof, this.serviceId, origin, input.code, input.browserName);
      } else if (grant || input.clientCode !== undefined || input.proof !== undefined) {
        throw new ServiceError('PAIRING_CODE_INVALID', '此授权格式与本机签发记录不匹配。');
      }
      const token = 'wg1_' + randomBytes(32).toString('base64url');
      const id = randomUUID();
      this.db.prepare('UPDATE pairing_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL').run(now,hash);
      this.db.prepare('INSERT INTO sessions(id,token_hash,browser_name,paired_at,last_used_at,origin) VALUES(?,?,?,?,?,?)').run(id,this.hash('session',token),input.browserName.trim(),now,now,origin);
      return { serviceId: this.serviceId, token, session: this.toSession({id,browser_name:input.browserName.trim(),paired_at:now,last_used_at:now,revoked_at:null,origin},id) };
    });
  }
  private active(token: string, origin: string): SessionRow {
    this.requireOrigin(origin);
    if (!/^wg1_[A-Za-z0-9_-]{43}$/.test(token)) throw new ServiceError('UNAUTHENTICATED', '需要有效的 Bearer 会话凭据；请重新配对。');
    const row = this.db.prepare('SELECT id,browser_name,origin,paired_at,last_used_at,revoked_at FROM sessions WHERE token_hash=?').get(this.hash('session',token)) as SessionRow | undefined;
    if (!row) throw new ServiceError('UNAUTHENTICATED', '会话不存在或不属于此服务；请重新配对。');
    if (row.origin !== origin) throw new ServiceError('ORIGIN_DENIED', '会话仅允许从配对时的网页来源访问。');
    if (row.revoked_at !== null) throw new ServiceError('SESSION_REVOKED', '此浏览器会话已撤销，请重新配对；已接受任务不受影响。');
    if (this.now() >= row.last_used_at + SESSION_IDLE_MS) throw new ServiceError('SESSION_EXPIRED', '此会话已连续 30 天未使用，请重新配对。');
    return row;
  }
  /** Recheck immediately before a stream emits data; keepalives must not renew idle expiry. */
  assertActive(token: string, origin: string): void { this.active(token,origin); }
  /** Authorization, renewal and each short operation share a transaction, including CLI revocation races. */
  withSession<T>(token: string, origin: string, operation: (session: Session) => T): T {
    return transaction(this.db, () => {
      const row = this.active(token,origin);
      row.last_used_at = Math.max(this.now(),row.last_used_at);
      this.db.prepare('UPDATE sessions SET last_used_at=? WHERE id=?').run(row.last_used_at,row.id);
      return operation(this.toSession(row,row.id));
    });
  }
  list(currentId?: string): Session[] {
    const rows = this.db.prepare('SELECT id,browser_name,origin,paired_at,last_used_at,revoked_at FROM sessions WHERE revoked_at IS NULL ORDER BY paired_at,id').all() as SessionRow[];
    return rows.map(row => this.toSession(row,currentId));
  }
  /** Call in the authenticated operation transaction, or through revokeLocal. */
  revoke(id: string): void {
    if (!this.db.isTransaction) throw new Error('Revocation requires a transaction');
    const row = this.db.prepare('SELECT revoked_at FROM sessions WHERE id=?').get(id);
    if (!row) throw new ServiceError('NOT_FOUND', '会话不存在，请刷新浏览器列表。');
    if (row['revoked_at'] !== null) return;
    const now = this.now();
    this.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now,id);
    new Repositories(this.db).appendEvent({ eventId:randomUUID(), type:'session.revoked', projectId:null,graphId:null,entityId:id,revision:1,occurredAt:new Date(now).toISOString(),payload:{sessionId:id} });
  }
  revokeLocal(id: string): void { transaction(this.db, () => this.revoke(id)); }
  private toSession(row: SessionRow, currentId?: string): Session {
    return { id:row.id,browserName:row.browser_name,origin:row.origin,pairedAt:new Date(row.paired_at).toISOString(),lastUsedAt:new Date(row.last_used_at).toISOString(),expiresAt:new Date(row.last_used_at + SESSION_IDLE_MS).toISOString(),current:row.id === currentId,state:this.now() >= row.last_used_at + SESSION_IDLE_MS ? 'expired' : 'active' };
  }
}
