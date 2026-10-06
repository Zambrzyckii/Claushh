import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { AUTH_API, AuthService } from './auth.service';
import { IGNORE_UNAUTHORIZED } from './ignore-unauthorized';

/** Endpoints for which 401 is a normal response and not a sign of an expired session (a refused passkey, too). */
const OWN_AUTH_ENDPOINTS: readonly string[] = [AUTH_API.me, AUTH_API.login, AUTH_API.logout, AUTH_API.passkeyLogin];

/**
 * When the API responds 401 to a regular request, the session has expired or was invalidated on the server.
 * Then we clear the state and reload the page to the login screen (AuthService.handleSessionExpired).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        !req.context.get(IGNORE_UNAUTHORIZED) &&
        isApiRequest(req.url) &&
        !OWN_AUTH_ENDPOINTS.includes(pathOf(req.url))
      ) {
        auth.handleSessionExpired();
      }
      return throwError(() => error);
    })
  );
};

function isApiRequest(url: string): boolean {
  return url === '/api' || url.startsWith('/api/');
}

function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0];
}
