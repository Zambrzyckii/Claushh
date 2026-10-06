import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

import { PasskeyCredentialJson } from '../browser/webauthn';

/**
 * The account's passkeys and the re-authentication that adding and removing one need.
 * Contract: docs/ARCHITECTURE.md, section "Authentication" → "Passkeys". The passkey login is in AuthService.
 */

export interface Passkey {
  /** The credential id in base64url. */
  id: string;
  name: string;
  createdAt: string;
  /** The passkey may be synced to other devices (backup eligible). */
  synced: boolean;
}

export type PasskeyErrorKind = 'invalid' | 'forbidden' | 'not-found' | 'conflict' | 'rate-limited' | 'network' | 'server';

/**
 * Error of a passkeys API call. `forbidden` (403): the password and code are needed first; `detail`: the server's
 * `message` (400, 409); `retryAfterSeconds`: the wait of a `rate-limited` (429).
 */
export class PasskeyApiError extends Error {
  constructor(
    readonly kind: PasskeyErrorKind,
    readonly detail: string | null = null,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(kind);
  }
}

export const PASSKEYS_API = {
  passkeys: '/api/auth/passkeys',
  creationOptions: '/api/auth/passkeys/creation-options',
  reauthenticate: '/api/auth/reauthenticate'
} as const;

const MAX_DETAIL_LENGTH = 500;

@Injectable({ providedIn: 'root' })
export class PasskeysApi {
  private readonly http = inject(HttpClient);

  list(): Observable<Passkey[]> {
    return this.http.get<Passkey[]>(PASSKEYS_API.passkeys).pipe(
      map((list) => list.map(toPasskey)),
      catchError((e: unknown) => throwError(() => toPasskeyApiError(e)))
    );
  }

  /** The password and a code again: for 5 minutes this session may add and remove passkeys. */
  reauthenticate(password: string, totpCode: string): Observable<void> {
    return this.http
      .post<void>(PASSKEYS_API.reauthenticate, { password, totpCode })
      .pipe(catchError((e: unknown) => throwError(() => toPasskeyApiError(e))));
  }

  /** The WebAuthn creation options for this account; `forbidden` without a recent re-authentication. */
  creationOptions(): Observable<PublicKeyCredentialCreationOptionsJSON> {
    return this.http
      .post<PublicKeyCredentialCreationOptionsJSON>(PASSKEYS_API.creationOptions, null)
      .pipe(catchError((e: unknown) => throwError(() => toPasskeyApiError(e))));
  }

  /** Stores the new passkey; without a name the server names it after the device. */
  add(credential: PasskeyCredentialJson, name: string | null): Observable<Passkey> {
    return this.http.post<Passkey>(PASSKEYS_API.passkeys, name === null ? { credential } : { credential, name }).pipe(
      map(toPasskey),
      catchError((e: unknown) => throwError(() => toPasskeyApiError(e)))
    );
  }

  rename(id: string, name: string): Observable<void> {
    return this.http
      .patch<void>(`${PASSKEYS_API.passkeys}/${encodeURIComponent(id)}`, { name })
      .pipe(catchError((e: unknown) => throwError(() => toPasskeyApiError(e))));
  }

  /** `forbidden` without a recent re-authentication. */
  remove(id: string): Observable<void> {
    return this.http
      .delete<void>(`${PASSKEYS_API.passkeys}/${encodeURIComponent(id)}`)
      .pipe(catchError((e: unknown) => throwError(() => toPasskeyApiError(e))));
  }
}

function toPasskey(p: Passkey): Passkey {
  return { id: p.id, name: p.name, createdAt: p.createdAt, synced: p.synced === true };
}

function toPasskeyApiError(error: unknown): PasskeyApiError {
  if (!(error instanceof HttpErrorResponse)) {
    return new PasskeyApiError('server');
  }
  const raw = (error.error as { message?: unknown } | null)?.message;
  const detail = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_DETAIL_LENGTH) : null;
  switch (error.status) {
    case 0:
      return new PasskeyApiError('network');
    case 400:
      return new PasskeyApiError('invalid', detail);
    case 403:
      return new PasskeyApiError('forbidden');
    case 404:
      return new PasskeyApiError('not-found');
    case 409:
      return new PasskeyApiError('conflict', detail);
    case 429: {
      const retryAfter = Number(error.headers.get('Retry-After'));
      return new PasskeyApiError('rate-limited', null, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
    }
    default:
      return new PasskeyApiError('server');
  }
}
