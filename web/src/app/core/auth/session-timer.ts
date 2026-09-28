import { DOCUMENT, DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { AuthService } from './auth.service';

/** How many milliseconds before the end the countdown warns and shows "Przedłuż" (extend). */
export const SESSION_WARNING_MS = 2 * 60_000;
/** Activity extends the session at most once per this many milliseconds. */
export const KEEPALIVE_INTERVAL_MS = 60_000;
/** After the countdown reaches zero, the server is asked about the session at most once per this many milliseconds. */
const VERIFY_INTERVAL_MS = 10_000;
/**
 * How long after the expiry time we wait for the server's response. After that, if the server still does not respond
 * (no network, tunnel failure), the session ends locally: the view with code must not stay on the screen forever.
 */
export const EXPIRY_GRACE_MS = 30_000;

const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const;

/**
 * Countdown to the end of the session and extending it on activity.
 *
 * - User activity (key press, click, scrolling, also in the editor and the terminal) calls
 *   `AuthService.keepAlive()`, at most once a minute. Background refresh alone does not extend the session.
 * - When the countdown reaches zero, we ask the server: an expired session ends with a return to login,
 *   and one extended in another tab simply updates the countdown.
 * - Safe without a network: if the server does not respond and `EXPIRY_GRACE_MS` has passed since the deadline,
 *   the session ends locally the same way as on 401.
 * Provided in the Workspace component. Description: docs/ARCHITECTURE.md, section "Authentication".
 */
@Injectable()
export class SessionTimer {
  private readonly auth = inject(AuthService);
  private readonly now = signal(Date.now());
  private lastKeepAlive = Date.now();
  private lastVerify = 0;
  private verifying = false;

  /** Remaining time in ms, or `null` when the server did not give an expiry time. */
  readonly remainingMs = computed(() => {
    const at = this.auth.expiresAt();
    return at === null ? null : Math.max(0, at - this.now());
  });
  readonly warning = computed(() => {
    const remaining = this.remainingMs();
    return remaining !== null && remaining <= SESSION_WARNING_MS;
  });
  /** E.g. "24:13" or "1:05:00". */
  readonly label = computed(() => {
    const remaining = this.remainingMs();
    return remaining === null ? null : formatDuration(remaining);
  });

  constructor() {
    const document = inject(DOCUMENT);
    const onActivity = () => this.onActivity();
    for (const type of ACTIVITY_EVENTS) {
      document.addEventListener(type, onActivity, { capture: true, passive: true });
    }
    const timer = setInterval(() => this.tick(), 1000);

    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      for (const type of ACTIVITY_EVENTS) {
        document.removeEventListener(type, onActivity, { capture: true });
      }
    });
  }

  /** The "Przedłuż" button: immediately, without the once-a-minute limit. */
  extend(): Promise<void> {
    this.lastKeepAlive = Date.now();
    return this.auth.keepAlive();
  }

  private onActivity(): void {
    if (Date.now() - this.lastKeepAlive >= KEEPALIVE_INTERVAL_MS) {
      void this.extend();
    }
  }

  private tick(): void {
    const now = Date.now();
    this.now.set(now);
    if (this.remainingMs() === 0 && !this.verifying && now - this.lastVerify >= VERIFY_INTERVAL_MS) {
      this.lastVerify = now;
      void this.checkExpired();
    }
  }

  /** The countdown reached zero: the server decides, and when it stays silent longer than `EXPIRY_GRACE_MS` after the deadline, we end locally. */
  private async checkExpired(): Promise<void> {
    this.verifying = true;
    try {
      const result = await this.auth.verifySession();
      const at = this.auth.expiresAt();
      if (result === 'unknown' && at !== null && Date.now() - at >= EXPIRY_GRACE_MS) {
        this.auth.handleSessionExpired();
      }
    } finally {
      this.verifying = false;
    }
  }
}

export function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}
