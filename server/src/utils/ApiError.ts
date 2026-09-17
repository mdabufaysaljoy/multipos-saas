export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'LIMIT_EXCEEDED'
  | 'SUBSCRIPTION_INACTIVE'
  /** The workspace's plan does not include Advanced Analytics. */
  | 'ADVANCED_ANALYTICS_REQUIRED'
  /** The workspace's subscription does not include the entitlement. */
  | 'ENTITLEMENT_REQUIRED'
  /** The module belongs to a different POS vertical than this workspace. */
  | 'VERTICAL_NOT_SUPPORTED'
  | 'UNPROCESSABLE'
  | 'TOO_MANY_REQUESTS'
  /** An external payment provider could not be reached or did not answer. */
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  LIMIT_EXCEEDED: 402,
  SUBSCRIPTION_INACTIVE: 402,
  ADVANCED_ANALYTICS_REQUIRED: 403,
  ENTITLEMENT_REQUIRED: 403,
  VERTICAL_NOT_SUPPORTED: 403,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details?: unknown;
  public readonly expose: boolean;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
    this.expose = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message: string, details?: unknown) { return new ApiError('BAD_REQUEST', message, details); }
  static validation(message: string, details?: unknown) { return new ApiError('VALIDATION_ERROR', message, details); }
  static unauthorized(message = 'Authentication required') { return new ApiError('UNAUTHORIZED', message); }
  static forbidden(message = 'You do not have permission to perform this action') { return new ApiError('FORBIDDEN', message); }
  static notFound(message = 'Resource not found') { return new ApiError('NOT_FOUND', message); }
  static conflict(message: string, details?: unknown) { return new ApiError('CONFLICT', message, details); }
  static insufficientStock(message: string, details?: unknown) { return new ApiError('INSUFFICIENT_STOCK', message, details); }
  static limitExceeded(message: string, details?: unknown) { return new ApiError('LIMIT_EXCEEDED', message, details); }
  static subscriptionInactive(message: string, details?: unknown) { return new ApiError('SUBSCRIPTION_INACTIVE', message, details); }
  static internal(message = 'Something went wrong') { return new ApiError('INTERNAL', message); }
}
