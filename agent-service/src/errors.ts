import type { ErrorCode, Json } from '@openworkgraph/protocol';
interface ServiceErrorOptions extends ErrorOptions { details?: Json; retryable?: boolean }
export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details: Json | undefined;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, options?: ServiceErrorOptions) { super(message, options); this.name = 'ServiceError'; this.code = code; this.details = options?.details; this.retryable = options?.retryable ?? false; }
}
