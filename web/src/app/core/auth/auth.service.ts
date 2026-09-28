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

/**
 * Response of `GET /api/auth/me` and `POST /api/auth/keepalive`. Relative times (in seconds), so that a wrongly
 * set device clock does not break the countdown: `expiresIn` until expiry due to inactivity,
 * `absoluteExpiresIn` until the hard end of the session regardless of activity.
 */
interface SessionTimes {
  expiresIn?: number | null;
  absoluteExpiresIn?: number | null;
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
  logout: '/api/auth/logout',
  keepAlive: '/api/auth/keepalive'
} as const;

/** Channel between tabs of the same browser: a logout in one tab closes the others. */
const AUTH_CHANNEL = 'claushh-auth';
const LOGOUT_MESSAGE = 'logout';
/** Another tab extended the session: `{ type: 'expiry', at }` (time in ms by this browser's clock). */
const EXPIRY_MESSAGE = 'expiry';

@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly navigation = inject(HardNavigation);

  private readonly state = signal<AuthState>({ status: 'unknown' });
  private pendingCheck: Promise<boolean> | null = null;
  private leaving = false;
  /**
   * A logout is in progress. When the server ends the session, it also closes its WebSockets, which could trigger "session expired"
   * before the logout finishes. During that time, session-expired signals are ignored.
   */
  private loggingOut = false;
  private readonly channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);

  private readonly expiry = signal<number | null>(null);

  readonly user = computed(() => {
    const state = this.state();
    return state.status === 'authenticated' ? state.user : null;
  });

  /** Moment of session expiry (ms, browser clock): the earlier of the inactivity limit and the hard limit. */
  readonly expiresAt = this.expiry.asReadonly();

  constructor() {
    this.channel?.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data === LOGOUT_MESSAGE) {
        // Only a logged-in tab reacts. A tab that is logging out by itself finishes that with the right message,
        // and a late signal must not reload a freshly opened login screen.
        if (!this.loggingOut && this.state().status === 'authenticated') {
          this.leave('/login');
        }
      } else if (isExpiryMessage(data)) {
        this.expiry.set(data.at);
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
    this.pendingCheck ??= firstValueFrom(this.http.get<SessionUser & SessionTimes>(AUTH_API.me))
      .then(
        (user) => {
          this.state.set({ status: 'authenticated', user: { userName: user.userName } });
          this.applyTimes(user);
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

  /**
   * Checks the session on the server, skipping the remembered result. Used when something outside HttpClient
   * (e.g. the console WebSocket) stopped working: 401 ends the session as in the interceptor,
   * and no connection changes nothing (the server may have been only briefly unavailable).
   */
  async verifySession(): Promise<void> {
    if (this.leaving || this.loggingOut) {
      return;
    }
    try {
      this.applyTimes(await firstValueFrom(this.http.get<SessionUser & SessionTimes>(AUTH_API.me)));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.handleSessionExpired();
      }
    }
  }

  /**
   * Extends the session after user activity. This is the only request that extends the session: regular API calls
   * (e.g. background refresh) do not, so without activity the session will expire. The interceptor handles 401.
   */
  async keepAlive(): Promise<void> {
    if (this.leaving) {
      return;
    }
    try {
      this.applyTimes(await firstValueFrom(this.http.post<SessionTimes>(AUTH_API.keepAlive, null)));
      const at = this.expiry();
      if (at !== null) {
        this.channel?.postMessage({ type: EXPIRY_MESSAGE, at });
      }
    } catch {
      // No connection: the countdown stays. The server verifies the expiry anyway.
    }
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
    this.loggingOut = true;
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
    if (this.leaving || this.loggingOut) {
      return;
    }
    const returnUrl = encodeURIComponent(this.navigation.currentUrl());
    this.channel?.postMessage(LOGOUT_MESSAGE);
    this.leave(`/login?reason=expired&returnUrl=${returnUrl}`);
  }

  private applyTimes(times: SessionTimes): void {
    const now = Date.now();
    const deadlines = [times.expiresIn, times.absoluteExpiresIn]
      .filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s >= 0)
      .map((s) => now + s * 1000);
    this.expiry.set(deadlines.length ? Math.min(...deadlines) : null);
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
 * The session and XSRF cookies are removed by the server (Set-Cookie). We deliberately do not use the Clear-Site-Data header:
 * Chrome can then stall the logout for several seconds (docs/ARCHITECTURE.md, "Authentication").
 */
function clearBrowserStorage(): void {
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {
    // Storage can be blocked (private mode, browser policy). There is nothing to clear.
  }
}

function isExpiryMessage(data: unknown): data is { type: string; at: number } {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === EXPIRY_MESSAGE &&
    typeof (data as { at?: unknown }).at === 'number'
  );
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
