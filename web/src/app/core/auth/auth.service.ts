import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { HardNavigation } from '../browser/hard-navigation';

/**
 * Browser-side login state.
 *
 * Security rule: the frontend does NOT store any tokens. The session is an HttpOnly cookie
 * set by the API and not accessible to JavaScript. Here we only keep in memory the information
 * "who is logged in", and the server always decides whether the session is valid (`GET /api/auth/me`).
 * API contract: docs/ARCHITECTURE.md, section "Authentication".
 */

export interface SessionUser {
  userName: string;
}

export interface LoginCredentials {
  userName: string;
  password: string;
  totpCode: string;
}

export type LoginFailure = 'invalid' | 'rate-limited' | 'network' | 'server';

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: LoginFailure; retryAfterSeconds?: number };

type AuthState =
  | { status: 'unknown' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: SessionUser };

export const AUTH_API = {
  me: '/api/auth/me',
  login: '/api/auth/login',
  logout: '/api/auth/logout'
} as const;

/** Channel between tabs of the same browser: a logout in one tab closes the others. */
const AUTH_CHANNEL = 'claushh-auth';
const LOGOUT_MESSAGE = 'logout';

@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly navigation = inject(HardNavigation);

  private readonly state = signal<AuthState>({ status: 'unknown' });
  private pendingCheck: Promise<boolean> | null = null;
  private leaving = false;
  private readonly channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);

  readonly user = computed(() => {
    const state = this.state();
    return state.status === 'authenticated' ? state.user : null;
  });

  constructor() {
    this.channel?.addEventListener('message', (event: MessageEvent) => {
      if (event.data === LOGOUT_MESSAGE) {
        this.leave('/login');
      }
    });
  }

  ngOnDestroy(): void {
    this.channel?.close();
  }

  /**
   * Checks the session on the server (once, then the result is remembered until the page reloads).
   * Any error, including no connection, is treated as no session.
   */
  ensureSession(): Promise<boolean> {
    const state = this.state();
    if (state.status !== 'unknown') {
      return Promise.resolve(state.status === 'authenticated');
    }
    this.pendingCheck ??= firstValueFrom(this.http.get<SessionUser>(AUTH_API.me))
      .then(
        (user) => {
          this.state.set({ status: 'authenticated', user: { userName: user.userName } });
          return true;
        },
        () => {
          this.state.set({ status: 'anonymous' });
          return false;
        }
      )
      .finally(() => {
        this.pendingCheck = null;
      });
    return this.pendingCheck;
  }

  async login(credentials: LoginCredentials): Promise<LoginResult> {
    try {
      await firstValueFrom(this.http.post(AUTH_API.login, credentials));
    } catch (error) {
      return toLoginFailure(error);
    }
    // After login we ask the server again: it confirms that the session cookie works
    // and issues a new XSRF token bound to the logged-in user.
    this.state.set({ status: 'unknown' });
    return (await this.ensureSession()) ? { ok: true } : { ok: false, reason: 'server' };
  }

  /**
   * Logout: invalidating the session on the server, clearing the state in the browser,
   * closing other tabs and a full reload to the login screen.
   * We always clear the local state, even when the server does not respond. Then the login screen
   * shows a warning that the session on the server may have stayed active.
   */
  async logout(): Promise<void> {
    let confirmed: boolean;
    try {
      await firstValueFrom(this.http.post(AUTH_API.logout, null));
      confirmed = true;
    } catch (error) {
      // 401 means the session no longer exists on the server anyway.
      confirmed = error instanceof HttpErrorResponse && error.status === 401;
    }
    this.channel?.postMessage(LOGOUT_MESSAGE);
    this.leave(confirmed ? '/login?logout=ok' : '/login?logout=unconfirmed');
  }

  /** Called by the interceptor when the API responds 401 to a regular request. */
  handleSessionExpired(): void {
    if (this.leaving) {
      return;
    }
    const returnUrl = encodeURIComponent(this.navigation.currentUrl());
    this.channel?.postMessage(LOGOUT_MESSAGE);
    this.leave(`/login?reason=expired&returnUrl=${returnUrl}`);
  }

  private leave(url: string): void {
    if (this.leaving) {
      return;
    }
    this.leaving = true;
    this.state.set({ status: 'anonymous' });
    clearBrowserStorage();
    this.navigation.replace(url);
  }
}

/**
 * The app does not store anything sensitive in browser storage, but just in case
 * (e.g. future UI settings) we clear it on every exit from the session.
 * The session and XSRF cookies are removed by the server (Set-Cookie + Clear-Site-Data).
 */
function clearBrowserStorage(): void {
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    // Storage can be blocked (private mode, browser policy). There is nothing to clear.
  }
}

function toLoginFailure(error: unknown): LoginResult {
  if (!(error instanceof HttpErrorResponse)) {
    return { ok: false, reason: 'server' };
  }
  if (error.status === 0) {
    return { ok: false, reason: 'network' };
  }
  if (error.status === 400 || error.status === 401) {
    return { ok: false, reason: 'invalid' };
  }
  if (error.status === 429) {
    const retryAfter = Number(error.headers.get('Retry-After'));
    return Number.isFinite(retryAfter) && retryAfter > 0
      ? { ok: false, reason: 'rate-limited', retryAfterSeconds: retryAfter }
      : { ok: false, reason: 'rate-limited' };
  }
  return { ok: false, reason: 'server' };
}
