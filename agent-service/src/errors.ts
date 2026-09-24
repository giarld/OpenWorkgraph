import type { ErrorCode } from '@openworkgraph/protocol';
export class ServiceError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'ServiceError'; this.code = code; }
}
