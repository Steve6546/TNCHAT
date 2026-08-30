/**
 * Error model ported from new-api `relaykit/types` (NewAPIError).
 *
 * Two details from the original are preserved because they change behaviour,
 * not just shape:
 *   - `skipRetry` (ErrOptionWithSkipRetry): certain failures must NOT be retried
 *     on another channel. Retrying a 413 or a malformed request only burns quota.
 *   - errors are rendered in the *client's* protocol. A Claude client talking to
 *     /v1/messages must receive an Anthropic-shaped error, not an OpenAI one.
 */

export type ErrorCode =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'
  | 'invalid_api_key'
  | 'insufficient_quota'
  | 'channel_error'
  | 'upstream_error';

export interface ErrorOptions {
  statusCode?: number;
  code?: ErrorCode;
  type?: string;
  param?: string | null;
  skipRetry?: boolean;
  /** Raw upstream payload, kept for debugging without leaking into responses. */
  upstream?: unknown;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly type: string;
  readonly param: string | null;
  readonly skipRetry: boolean;
  readonly upstream?: unknown;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'GatewayError';
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'api_error';
    this.type = options.type ?? this.code;
    this.param = options.param ?? null;
    this.skipRetry = options.skipRetry ?? false;
    this.upstream = options.upstream;
  }

  static badRequest(message: string, param?: string): GatewayError {
    return new GatewayError(message, {
      statusCode: 400,
      code: 'invalid_request_error',
      param: param ?? null,
      skipRetry: true,
    });
  }

  static unauthorized(message = 'Invalid API key'): GatewayError {
    return new GatewayError(message, {
      statusCode: 401,
      code: 'invalid_api_key',
      type: 'authentication_error',
      skipRetry: true,
    });
  }

  static forbidden(message: string): GatewayError {
    return new GatewayError(message, {
      statusCode: 403,
      code: 'permission_error',
      skipRetry: true,
    });
  }

  static notFound(message: string): GatewayError {
    return new GatewayError(message, {
      statusCode: 404,
      code: 'not_found_error',
      skipRetry: true,
    });
  }

  static tooLarge(message = 'Request entity too large'): GatewayError {
    return new GatewayError(message, {
      statusCode: 413,
      code: 'invalid_request_error',
      skipRetry: true,
    });
  }

  /** Upstream failure. Retried on another channel unless marked otherwise. */
  static upstream(message: string, statusCode = 502, upstream?: unknown): GatewayError {
    return new GatewayError(message, {
      statusCode,
      code: 'upstream_error',
      upstream,
    });
  }

  static noChannel(model: string): GatewayError {
    return new GatewayError(`No enabled channel available for model "${model}"`, {
      statusCode: 503,
      code: 'channel_error',
      skipRetry: true,
    });
  }

  /** Anthropic error envelope: { type: "error", error: { type, message } } */
  toClaude(): { type: 'error'; error: { type: string; message: string } } {
    return {
      type: 'error',
      error: { type: this.type, message: this.message },
    };
  }

  /** OpenAI error envelope: { error: { message, type, param, code } } */
  toOpenAI(): {
    error: { message: string; type: string; param: string | null; code: string };
  } {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

/** Normalise anything thrown into a GatewayError so route handlers stay simple. */
export function toGatewayError(value: unknown): GatewayError {
  if (isGatewayError(value)) return value;
  if (value instanceof Error) {
    return new GatewayError(value.message, { statusCode: 500, cause: value });
  }
  return new GatewayError('Unexpected internal error', { statusCode: 500, cause: value });
}
