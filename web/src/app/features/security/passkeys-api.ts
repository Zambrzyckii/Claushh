import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { mapHttpError, readHttpFailure } from '../../core/api/api-error';
import { PasskeyCredentialJson } from '../../core/browser/webauthn';

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

@Injectable({ providedIn: 'root' })
export class PasskeysApi {
  private readonly http = inject(HttpClient);

  list(): Observable<Passkey[]> {
    return this.http.get<Passkey[]>(PASSKEYS_API.passkeys).pipe(
      map((list) => list.map(toPasskey)),
      mapHttpError(toPasskeyApiError)
    );
  }

  /** The password and a code again: for 5 minutes this session may add and remove passkeys. */
  reauthenticate(password: string, totpCode: string): Observable<void> {
    return this.http
      .post<void>(PASSKEYS_API.reauthenticate, { password, totpCode })
      .pipe(mapHttpError(toPasskeyApiError));
  }

  /** The WebAuthn creation options for this account; `forbidden` without a recent re-authentication. */
  creationOptions(): Observable<PublicKeyCredentialCreationOptionsJSON> {
    return this.http
      .post<PublicKeyCredentialCreationOptionsJSON>(PASSKEYS_API.creationOptions, null)
      .pipe(mapHttpError(toPasskeyApiError));
  }

  /** Stores the new passkey; without a name the server names it after the device. */
  add(credential: PasskeyCredentialJson, name: string | null): Observable<Passkey> {
    return this.http.post<Passkey>(PASSKEYS_API.passkeys, name === null ? { credential } : { credential, name }).pipe(
      map(toPasskey),
      mapHttpError(toPasskeyApiError)
    );
  }

  rename(id: string, name: string): Observable<void> {
    return this.http
      .patch<void>(`${PASSKEYS_API.passkeys}/${encodeURIComponent(id)}`, { name })
      .pipe(mapHttpError(toPasskeyApiError));
  }

  /** `forbidden` without a recent re-authentication. */
  remove(id: string): Observable<void> {
    return this.http
      .delete<void>(`${PASSKEYS_API.passkeys}/${encodeURIComponent(id)}`)
      .pipe(mapHttpError(toPasskeyApiError));
  }
}

function toPasskey(p: Passkey): Passkey {
  return { id: p.id, name: p.name, createdAt: p.createdAt, synced: p.synced === true };
}

function toPasskeyApiError(error: unknown): PasskeyApiError {
  const failure = readHttpFailure(error);
  if (!failure) {
    return new PasskeyApiError('server');
  }
  const detail = failure.detail;
  switch (failure.status) {
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
    case 429:
      return new PasskeyApiError('rate-limited', null, failure.retryAfterSeconds);
    default:
      return new PasskeyApiError('server');
  }
}
