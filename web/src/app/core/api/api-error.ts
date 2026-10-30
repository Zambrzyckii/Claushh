import { HttpErrorResponse } from '@angular/common/http';

/**
 * Error of a workspaces, git or search API call (files have their own FileApiError).
 * `detail` is an optional description from the server (the `message` field in the error body, e.g. a git message).
 * We display it only as text.
 */
export type ApiErrorKind = 'invalid' | 'not-found' | 'conflict' | 'remote' | 'network' | 'server';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly detail: string | null = null
  ) {
    super(kind);
  }
}

const MAX_DETAIL_LENGTH = 500;

/** What a failed request says, read once for every API client. */
export interface HttpFailure {
  /** The HTTP status, 0 when no answer arrived. */
  readonly status: number;
  /** The server's `message`, trimmed and cut to 500 characters, null when missing, empty or not text. */
  readonly detail: string | null;
  /** `Retry-After` in seconds when it is a positive finite number, else null. */
  readonly retryAfterSeconds: number | null;
  /** The parsed error body, for a field one client reads itself (`currentVersion`). */
  readonly body: unknown;
}

/** null when `error` is not an `HttpErrorResponse` (every mapper turns that into its `server` kind). */
export function readHttpFailure(error: unknown): HttpFailure | null {
  if (!(error instanceof HttpErrorResponse)) {
    return null;
  }
  const raw = (error.error as { message?: unknown } | null)?.message;
  const detail = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_DETAIL_LENGTH) : null;
  const retryAfter = Number(error.headers.get('Retry-After'));
  return {
    status: error.status,
    detail,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    body: error.error
  };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  const failure = readHttpFailure(error);
  if (!failure) {
    return new ApiError('server');
  }
  const detail = failure.detail;
  switch (failure.status) {
    case 0:
      return new ApiError('network');
    case 400:
      return new ApiError('invalid', detail);
    case 404:
      return new ApiError('not-found', detail);
    case 409:
      return new ApiError('conflict', detail);
    case 502:
      return new ApiError('remote', detail);
    default:
      return new ApiError('server', detail);
  }
}
