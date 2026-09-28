import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { toApiError } from './api-error';

/**
 * Active sessions and login history.
 * Contract: docs/ARCHITECTURE.md, section "Authentication" → "Sessions and login history".
 */

export interface ActiveSession {
  id: string;
  /** The session this request came from (this browser). */
  current: boolean;
  /** Device description from the User-Agent header, e.g. "Chrome · Linux". */
  device: string;
  ip: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface LoginAttempt {
  at: string;
  ip: string;
  device: string;
  success: boolean;
}

const SESSIONS_API = {
  sessions: '/api/auth/sessions',
  revokeOthers: '/api/auth/sessions/revoke-others',
  logins: '/api/auth/logins'
} as const;

@Injectable({ providedIn: 'root' })
export class SessionsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<ActiveSession[]> {
    return this.http.get<ActiveSession[]>(SESSIONS_API.sessions).pipe(
      map((list) =>
        list.map((s) => ({
          id: s.id,
          current: s.current === true,
          device: s.device,
          ip: s.ip,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt
        }))
      ),
      catchError((e: unknown) => throwError(() => toApiError(e)))
    );
  }

  /** Ends another session. Your own session is not ended this way, only by logging out. */
  revoke(id: string): Observable<void> {
    return this.http
      .delete<void>(`${SESSIONS_API.sessions}/${encodeURIComponent(id)}`)
      .pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }

  revokeOthers(): Observable<void> {
    return this.http
      .post<void>(SESSIONS_API.revokeOthers, null)
      .pipe(catchError((e: unknown) => throwError(() => toApiError(e))));
  }

  logins(): Observable<LoginAttempt[]> {
    return this.http.get<LoginAttempt[]>(SESSIONS_API.logins).pipe(
      map((list) => list.map((l) => ({ at: l.at, ip: l.ip, device: l.device, success: l.success === true }))),
      catchError((e: unknown) => throwError(() => toApiError(e)))
    );
  }
}
