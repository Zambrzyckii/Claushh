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

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (!(error instanceof HttpErrorResponse)) {
    return new ApiError('server');
  }
  const raw = (error.error as { message?: unknown } | null)?.message;
  const detail = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_DETAIL_LENGTH) : null;
  switch (error.status) {
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
