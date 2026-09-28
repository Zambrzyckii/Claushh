import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { HardNavigation } from '../browser/hard-navigation';
import { IGNORE_UNAUTHORIZED } from './ignore-unauthorized';

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

/** Response of `GET /api/auth/me`. */
type MeResponse = SessionUser & SessionTimes;

/**
 * Response of `GET /api/auth/me` and `POST /api/auth/keepalive`. Relative times (in seconds), so that a wrongly
 * set device clock does not break the countdown: `expiresIn` until expiry due to inactivity,
 * `absoluteExpiresIn` until the hard end of the session regardless of activity. `sessionId` is the public identifier
 * of the cookie's session (the same as in `/api/auth/sessions`, never a secret).
 */
interface SessionTimes {
  expiresIn?: number | null;
  absoluteExpiresIn?: number | null;
  sessionId?: string | null;
}

export interface LoginCredentials {
  userName: string;
  password: string;
  totpCode: string;
}

export type LoginFailure = 'invalid' | 'rate-limited' | 'network' | 'server';

/**
 * Result of checking the session on the server: `valid` (plus new expiry times), `expired` (401)
 * or `unknown` (no connection, server error, no response within `VERIFY_TIMEOUT_MS`).
 */
export type SessionCheck = 'valid' | 'expired' | 'unknown';

/**
 * Result of `confirmLogout`: `ended` (that session is gone and the browser has none), `newer-session` (that session
 * is gone, but the cookie belongs to another, newer session, e.g. after a login in another tab), `failed` (no confirmation).
 */
export type LogoutConfirmation = 'ended' | 'newer-session' | 'failed';

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
  keepAlive: '/api/auth/keepalive',
  sessions: '/api/auth/sessions'
} as const;

/** Channel between tabs of the same browser: a logout in one tab closes the others. */
const AUTH_CHANNEL = 'claushh-auth';

/** How the session ended in the tab that sent the message. Other tabs finish with the same message. */
type LogoutResult = 'ok' | 'unconfirmed' | 'expired';

/**
 * Channel messages: `logout` (session ended in another tab), `expiry` (another tab extended the session,
 * `at` is the time in ms by this browser's clock) and `session` (another tab logged in: the cookie now belongs
 * to session `sessionId`, so on logout the marker gets the right identifier).
 */
type ChannelMessage =
  | { type: 'logout'; result: LogoutResult }
  | { type: 'expiry'; at: number }
  | { type: 'session'; sessionId: string };

/** The longest we wait for a response when checking the session. No response means the result `unknown`. */
const VERIFY_TIMEOUT_MS = 10_000;
/**
 * The longest a logout waits. After that, the logout ends locally as unconfirmed: during a logout,
 * "session expired" signals are ignored, so a hung request would leave the view with code on the screen.
 */
const LOGOUT_TIMEOUT_MS = 10_000;

/**
 * Marker in `localStorage`: the logout was not confirmed, and the value is the public identifier of the session
 * to end (`''` when unknown). Only the app writes it, right before reloading, so an external link
 * (`/login?logout=unconfirmed`) will not trigger an automatic logout. While it exists, no tab of this browser
 * lets anyone into the app without logging in (guards), and the login screen retries the logout. It is removed after confirmation
 * or after a successful login.
 */
const PENDING_LOGOUT_KEY = 'claushh-pending-logout';

/**
 * Lock (Web Locks) shared by the tabs of this browser: login and logout retry must not interleave.
 * Otherwise `POST /logout` from a tab retrying the logout could end the session just being created in another tab
 * or invalidate its XSRF token in the middle of the login.
 */
const AUTH_LOCK = 'claushh-auth';

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
  /** Public identifier of the current session from `GET /api/auth/me`. */
  private sessionId: string | null = null;

  readonly user = computed(() => {
    const state = this.state();
    return state.status === 'authenticated' ? state.user : null;
  });

  /** Moment of session expiry (ms, browser clock): the earlier of the inactivity limit and the hard limit. */
  readonly expiresAt = this.expiry.asReadonly();

  constructor() {
    this.channel?.addEventListener('message', (event: MessageEvent) => {
      const message = asChannelMessage(event.data);
      if (message?.type === 'logout') {
        // Only a logged-in tab reacts. A tab that is logging out by itself finishes that with the right message,
        // and a late signal must not reload a freshly opened login screen.
        if (!this.loggingOut && this.state().status === 'authenticated') {
          this.leave(this.loginUrl(message.result));
        }
      } else if (message?.type === 'expiry') {
        this.expiry.set(message.at);
      } else if (message?.type === 'session') {
        this.sessionId = message.sessionId;
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
    this.pendingCheck ??= firstValueFrom(this.http.get<MeResponse>(AUTH_API.me))
      .then(
        (user) => {
          this.state.set({ status: 'authenticated', user: { userName: user.userName } });
          this.sessionId = user.sessionId ?? null;
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
   * (e.g. the console WebSocket) stopped working or the session countdown reached zero: 401 ends the session as
   * in the interceptor. No connection by itself changes nothing (the server may have been only briefly unavailable),
   * but the result `unknown` lets the caller end the session locally (SessionTimer after the expiry time).
   */
  async verifySession(): Promise<SessionCheck> {
    if (this.leaving || this.loggingOut) {
      return 'unknown';
    }
    try {
      const me = await firstValueFrom(this.http.get<MeResponse>(AUTH_API.me).pipe(timeout(VERIFY_TIMEOUT_MS)));
      this.applyTimes(me);
      this.sessionId = me.sessionId ?? this.sessionId;
      return 'valid';
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.handleSessionExpired();
        return 'expired';
      }
      return 'unknown';
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
      const times = await firstValueFrom(this.http.post<SessionTimes>(AUTH_API.keepAlive, null));
      this.applyTimes(times);
      this.sessionId = times.sessionId ?? this.sessionId;
      const at = this.expiry();
      if (at !== null) {
        this.post({ type: 'expiry', at });
      }
    } catch {
      // No connection: the countdown stays. The server verifies the expiry anyway.
    }
  }

  login(credentials: LoginCredentials): Promise<LoginResult> {
    return withAuthLock(() => this.loginNow(credentials));
  }

  private async loginNow(credentials: LoginCredentials): Promise<LoginResult> {
    // Login requires an XSRF token issued for the current (anonymous) identity. An old token (e.g. after an unconfirmed
    // logout) or no token (logout removes it) would give 400, so always get a fresh one from `GET /api/auth/me` first.
    await firstValueFrom(this.http.get(AUTH_API.me).pipe(timeout(VERIFY_TIMEOUT_MS))).catch(() => undefined);
    try {
      await firstValueFrom(this.http.post(AUTH_API.login, credentials));
    } catch (error) {
      return toLoginFailure(error);
    }
    // After login we ask the server again: it confirms that the session cookie works
    // and issues a new XSRF token bound to the logged-in user.
    this.state.set({ status: 'unknown' });
    if (!(await this.ensureSession())) {
      return { ok: false, reason: 'server' };
    }
    if (this.sessionId) {
      this.post({ type: 'session', sessionId: this.sessionId });
    }
    await this.finishPendingLogout(); // already with the new session and its XSRF token
    return { ok: true };
  }

  /**
   * Logout: invalidating the session on the server, clearing the state in the browser,
   * closing other tabs and a full reload to the login screen.
   * We always clear the local state, even when the server does not respond. Then the login screen
   * shows a warning that the session on the server may have stayed active.
   */
  async logout(): Promise<void> {
    this.loggingOut = true;
    // Without an identifier: we end the session the cookie belongs to, i.e. the one this browser uses.
    const result: LogoutResult = (await this.endServerSession(null)) ? 'ok' : 'unconfirmed';
    this.post({ type: 'logout', result });
    this.leave(this.loginUrl(result));
  }

  /**
   * Public identifier of the session whose logout the server did not confirm (marker written by the app
   * before reloading). `null` when there is no marker (e.g. an address from an external link), `''`
   * when the logout is not confirmed but the session identifier was unknown.
   */
  pendingLogout(): string | null {
    try {
      return localStorage.getItem(PENDING_LOGOUT_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Whether the unconfirmed logout marker can be written (`localStorage` works). Without it, the screen
   * `/login?logout=unconfirmed&marker=none` is shown without a marker, with a warning and a button.
   */
  storageAvailable(): boolean {
    try {
      localStorage.setItem(STORAGE_PROBE_KEY, '1');
      localStorage.removeItem(STORAGE_PROBE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the browser definitely has no session (`GET /api/auth/me` responds 401). It only checks and ends nothing,
   * so it may be done without an unconfirmed logout marker (e.g. when another tab has already completed it).
   */
  async hasNoSession(): Promise<boolean> {
    try {
      await firstValueFrom(this.http.get(AUTH_API.me).pipe(timeout(VERIFY_TIMEOUT_MS)));
      return false;
    } catch (error) {
      return error instanceof HttpErrorResponse && error.status === 401;
    }
  }

  /**
   * After a successful login: the old session from the unconfirmed logout is ended by identifier
   * (already from the new session), and the marker is removed. An error does not block the login: the session expires by itself,
   * and it is visible in the "Bezpieczeństwo" (Security) window.
   */
  private async finishPendingLogout(): Promise<void> {
    const sessionId = this.pendingLogout();
    if (sessionId === null) {
      return;
    }
    if (sessionId) {
      await firstValueFrom(
        this.http
          .delete(`${AUTH_API.sessions}/${encodeURIComponent(sessionId)}`, {
            context: new HttpContext().set(IGNORE_UNAUTHORIZED, true)
          })
          .pipe(timeout(LOGOUT_TIMEOUT_MS))
      ).catch(() => undefined);
    }
    forgetPendingLogout(sessionId);
  }

  /**
   * Retries ending session `sessionId` after an unconfirmed logout (login screen with `logout=unconfirmed`).
   * Does not change this tab's login state. Result: see `LogoutConfirmation`.
   *
   * First `GET /api/auth/me` (fresh XSRF token): 401 means the cookie no longer has a valid session.
   * If the cookie still belongs to that session, a regular logout follows. If it belongs to a new one (meanwhile
   * someone logged in in this browser, e.g. in another tab), that session is ended by identifier,
   * and the new one stays. Without an identifier (manually typed address), it ends the current session.
   */
  async confirmLogout(sessionId: string | null): Promise<LogoutConfirmation> {
    const result = await withAuthLock(() => this.endSession(sessionId));
    if (result !== 'failed') {
      // Only if the marker still points to this session: another tab may have written a newer one meanwhile.
      forgetPendingLogout(sessionId ?? '');
    }
    return result;
  }

  private async endSession(sessionId: string | null): Promise<LogoutConfirmation> {
    let me: MeResponse;
    try {
      me = await firstValueFrom(this.http.get<MeResponse>(AUTH_API.me).pipe(timeout(LOGOUT_TIMEOUT_MS)));
    } catch (error) {
      return error instanceof HttpErrorResponse && error.status === 401 ? 'ended' : 'failed';
    }
    if (!sessionId || !me.sessionId || me.sessionId === sessionId) {
      return (await this.endServerSession(sessionId)) ? 'ended' : 'failed';
    }
    try {
      await firstValueFrom(
        this.http
          .delete(`${AUTH_API.sessions}/${encodeURIComponent(sessionId)}`, {
            context: new HttpContext().set(IGNORE_UNAUTHORIZED, true)
          })
          .pipe(timeout(LOGOUT_TIMEOUT_MS))
      );
      return 'newer-session';
    } catch (error) {
      // 404: that session no longer exists.
      return error instanceof HttpErrorResponse && error.status === 404 ? 'newer-session' : 'failed';
    }
  }

  /**
   * The session ended without a logout: the API responded 401 (interceptor, session check) or the countdown passed
   * the deadline and the server does not respond (SessionTimer). All tabs return to login with a session expiry message.
   */
  handleSessionExpired(): void {
    if (this.leaving || this.loggingOut) {
      return;
    }
    this.post({ type: 'logout', result: 'expired' });
    this.leave(this.loginUrl('expired'));
  }

  /**
   * `POST /api/auth/logout`. `true` when the server confirmed the end of the session (401: the session is gone anyway).
   * With `sessionId`, the server ends the session only if the cookie still belongs to it (otherwise 409 and it ends nothing),
   * so a late logout will not end a new session.
   */
  private async endServerSession(sessionId: string | null): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post(AUTH_API.logout, sessionId ? { sessionId } : null).pipe(timeout(LOGOUT_TIMEOUT_MS)));
      return true;
    } catch (error) {
      return error instanceof HttpErrorResponse && error.status === 401;
    }
  }

  private loginUrl(result: LogoutResult): string {
    switch (result) {
      case 'ok':
        return '/login?logout=ok';
      case 'unconfirmed':
        return '/login?logout=unconfirmed';
      case 'expired':
        return `/login?reason=expired&returnUrl=${encodeURIComponent(this.navigation.currentUrl())}`;
    }
  }

  private post(message: ChannelMessage): void {
    this.channel?.postMessage(message);
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
    if (url.startsWith('/login?logout=unconfirmed') && !rememberPendingLogout(this.sessionId ?? '')) {
      // The marker cannot be written (storage blocked). The login screen will show a warning and a button
      // ("marker=none" works only when storage really does not work, so an external link cannot fake it).
      url += '&marker=none';
    }
    this.navigation.replace(url);
  }
}

/**
 * The app does not store anything sensitive in browser storage, but just in case
 * (e.g. future UI settings) we clear it on every exit from the session. The only entry written afterwards is the
 * unconfirmed logout marker (`PENDING_LOGOUT_KEY`, public session identifier).
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

/**
 * Writes the unconfirmed logout marker (the login screen will complete the logout of exactly this session,
 * and until then no tab lets anyone into the app without logging in). `false` when storage does not work.
 */
function rememberPendingLogout(sessionId: string): boolean {
  try {
    localStorage.setItem(PENDING_LOGOUT_KEY, sessionId);
    return localStorage.getItem(PENDING_LOGOUT_KEY) === sessionId;
  } catch {
    return false;
  }
}

const STORAGE_PROBE_KEY = 'claushh-storage-probe';

/** Runs `action` under the `AUTH_LOCK` lock (without Web Locks, e.g. in an older browser or in tests: immediately). */
async function withAuthLock<T>(action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? await locks.request(AUTH_LOCK, () => action()) : await action();
}

/** Removes the marker if it still points to session `sessionId` (compare and remove, because tabs may change it). */
function forgetPendingLogout(sessionId: string): void {
  try {
    if (localStorage.getItem(PENDING_LOGOUT_KEY) === sessionId) {
      localStorage.removeItem(PENDING_LOGOUT_KEY);
    }
  } catch {
    // as above
  }
}

/** Channel message after a shape check (the channel exists only within this app, but we do not trust it blindly). */
function asChannelMessage(data: unknown): ChannelMessage | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const { type, result, at } = data as { type?: unknown; result?: unknown; at?: unknown };
  if (type === 'logout' && (result === 'ok' || result === 'unconfirmed' || result === 'expired')) {
    return { type, result };
  }
  if (type === 'expiry' && typeof at === 'number' && Number.isFinite(at)) {
    return { type, at };
  }
  const { sessionId } = data as { sessionId?: unknown };
  if (type === 'session' && typeof sessionId === 'string' && sessionId !== '') {
    return { type, sessionId };
  }
  return null;
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
