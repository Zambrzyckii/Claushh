import { Component, DestroyRef, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { AuthService, LoginResult, PasskeyLoginResult } from '../../core/auth/auth.service';
import { safeReturnUrl } from '../../core/auth/return-url';
import { WebAuthn } from '../../core/browser/webauthn';
import { formatWait } from '../../core/text/format';

/**
 * Login screen: login, password and a 6-digit TOTP code from the phone app.
 * Or a passkey, without a user name, where the browser can use one (docs/ARCHITECTURE.md, "Flows").
 * Error messages are deliberately generic: they do not reveal which field was wrong.
 * After a failed attempt the password and the code are cleared from the form.
 *
 * After an unconfirmed logout (`?logout=unconfirmed`) the screen retries ending the session on the server:
 * on its own (right away, after 3 s, after 10 s, then every 30 s, until the server confirms) only when the app left a marker
 * with the session identifier (`AuthService.pendingLogout`), so a link from outside will not log anyone out. It can always be
 * done with the button. Retrying ends before login, so that a late logout does not end the new session.
 */
@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss'
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;

  /** Whether this browser can log in with a passkey; otherwise the button is hidden. */
  protected readonly passkeys = inject(WebAuthn).available();

  protected readonly form = inject(NonNullableFormBuilder).group({
    userName: ['', [Validators.required, Validators.maxLength(256)]],
    password: ['', [Validators.required, Validators.maxLength(1024)]],
    totpCode: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]]
  });

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal(noticeFor(this.query.get('reason'), this.query.get('logout')));
  /** The server has not yet confirmed the end of the previous session. */
  protected readonly logoutUnconfirmed = signal(this.query.get('logout') === 'unconfirmed');
  protected readonly retryingLogout = signal(false);
  /** Unconfirmed logout without a marker, because storage does not work: only the button ends the session. */
  private readonly storageBlocked =
    this.logoutUnconfirmed() && this.query.get('marker') === 'none' && !this.auth.storageAvailable();

  private logoutRetry: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRetries = false;

  constructor() {
    if (this.logoutUnconfirmed()) {
      void this.autoRetry(0);
    }
    inject(DestroyRef).onDestroy(() => this.cancelLogoutRetries());
  }

  /**
   * Automatic attempt number `attempt`, followed by the next one according to `LOGOUT_RETRY_DELAYS_MS`.
   * Only with an app marker with the session identifier: without it nothing is ended on its own.
   */
  private async autoRetry(attempt: number): Promise<void> {
    const pending = this.pending();
    if (!pending) {
      // No marker (another tab already finished the logout) or no session identifier: we only check
      // whether the session is already gone. Ending it (without an identifier) is possible with the button.
      if (pending === null) {
        await this.checkWithoutMarker();
      } else if (await this.auth.hasNoSession()) {
        this.markConfirmed();
      }
      return;
    }
    await this.retryLogout();
    if (!this.stopRetries && this.logoutUnconfirmed()) {
      const delay = LOGOUT_RETRY_DELAYS_MS[Math.min(attempt, LOGOUT_RETRY_DELAYS_MS.length - 1)];
      this.retryTimer = setTimeout(() => void this.autoRetry(attempt + 1), delay);
    }
  }

  /**
   * One attempt to end the session from the marker. The marker is read every time, because another tab could have changed it
   * (e.g. a new unconfirmed logout of another session). "Logged out" only when the marker is gone.
   */
  protected retryLogout(): Promise<void> {
    if (this.stopRetries || !this.logoutUnconfirmed()) {
      return Promise.resolve();
    }
    this.logoutRetry ??= (async () => {
      this.retryingLogout.set(true);
      try {
        const pending = this.pending();
        if (pending === null) {
          await this.checkWithoutMarker();
          return;
        }
        const result = await this.auth.confirmLogout(pending || null);
        // Continue when another tab wrote a newer marker in the meantime (without storage there is no marker, so this cannot happen).
        if (result === 'failed' || (!this.storageBlocked && this.pending() !== null)) {
          return;
        }
        if (result === 'ended') {
          this.markConfirmed();
        } else {
          // That session is gone, but the browser has a newer one (e.g. a login in another tab or a login here
          // after which the session could not be checked): this is not "logged out", just a regular session, so on to the app.
          this.cancelLogoutRetries();
          await this.router.navigateByUrl('/', { replaceUrl: true });
        }
      } finally {
        this.retryingLogout.set(false);
        this.logoutRetry = null;
      }
    })();
    return this.logoutRetry;
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    await this.startLogin();
    const result = await this.auth.login(this.form.getRawValue());

    if (result.ok) {
      this.form.reset();
      await this.enterApp();
      return;
    }

    this.form.controls.password.reset();
    this.form.controls.totpCode.reset();
    this.loginFailed(errorMessage(result));
  }

  /** "Log in with a passkey": no user name, the browser asks for the passkey (docs/ARCHITECTURE.md, "Flows"). */
  protected async passkeyLogin(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    await this.startLogin();
    const result = await this.auth.loginWithPasskey();
    if (result.ok) {
      await this.enterApp();
      return;
    }
    this.loginFailed(passkeyErrorMessage(result));
  }

  /** An ongoing logout retry must end before login: otherwise it could end the new session. */
  private async startLogin(): Promise<void> {
    this.submitting.set(true);
    this.error.set(null);
    this.cancelLogoutRetries();
    await this.logoutRetry;
  }

  /** The login screen disappears from history: "Back" will not return to it (e.g. to an outdated logout warning). */
  private async enterApp(): Promise<void> {
    await this.router.navigateByUrl(safeReturnUrl(this.query.get('returnUrl')), { replaceUrl: true });
  }

  /** There is no new session, so the retry (and the "Retry logout" button) can end the previous one again. */
  private loginFailed(message: string): void {
    this.error.set(message);
    this.submitting.set(false);
    this.stopRetries = false;
    if (this.logoutUnconfirmed()) {
      void this.autoRetry(LOGOUT_RETRY_DELAYS_MS.length);
    }
  }

  /** Marker from storage; with blocked storage `''` (session to be ended, identifier unknown). */
  private pending(): string | null {
    return this.auth.pendingLogout() ?? (this.storageBlocked ? '' : null);
  }

  /**
   * The marker is gone, so another tab finished the logout or logged in again. We only check:
   * no session → "Logged out", a (new) session exists → on to the app, as with every login screen with a session.
   */
  private async checkWithoutMarker(): Promise<void> {
    if (await this.auth.hasNoSession()) {
      this.markConfirmed();
    } else if (this.auth.pendingLogout() === null) {
      this.cancelLogoutRetries();
      await this.router.navigateByUrl('/', { replaceUrl: true });
    }
  }

  private markConfirmed(): void {
    this.cancelLogoutRetries();
    this.logoutUnconfirmed.set(false);
    this.notice.set({ text: 'Logged out. The server confirmed the session ended.', warning: false });
  }

  private cancelLogoutRetries(): void {
    this.stopRetries = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

/**
 * Intervals between automatic attempts to end the session after an unconfirmed logout (the first one right away):
 * after 3 s, 7 s later (10 s from entry), and then every 30 s, until the server confirms.
 */
const LOGOUT_RETRY_DELAYS_MS = [3_000, 7_000, 30_000];

function errorMessage(result: Extract<LoginResult, { ok: false }>): string {
  switch (result.reason) {
    case 'invalid':
      return 'Invalid login details.';
    case 'rate-limited':
      return result.retryAfterSeconds
        ? `Too many attempts. Try again in ${formatWait(result.retryAfterSeconds)}`
        : 'Too many attempts. Try again later.';
    case 'network':
      return 'No connection to the server.';
    case 'server':
      return 'Server error. Try again.';
  }
}

/** Messages of a passkey login; the server's answers other than a refusal read as for a password login. */
function passkeyErrorMessage(result: Extract<PasskeyLoginResult, { ok: false }>): string {
  switch (result.reason) {
    case 'cancelled':
      return 'Passkey login cancelled.';
    case 'not-here':
      return "Passkeys work only at the portal's domain name.";
    case 'already-registered':
    case 'failed':
      return 'The passkey could not be used.';
    case 'invalid':
      return 'The passkey was not accepted.';
    default:
      return errorMessage(result);
  }
}

function noticeFor(reason: string | null, logout: string | null): { text: string; warning: boolean } | null {
  if (logout === 'unconfirmed') {
    return {
      text:
        'The data in this browser was cleared, but the server did not confirm that the session ended. ' +
        "If this is someone else's computer, log in and log out again when the connection is back.",
      warning: true
    };
  }
  if (logout === 'ok') {
    return { text: 'Logged out.', warning: false };
  }
  if (reason === 'expired') {
    return { text: 'Session expired. Log in again.', warning: false };
  }
  return null;
}
