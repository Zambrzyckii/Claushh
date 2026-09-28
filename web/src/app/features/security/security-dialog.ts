import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ActiveSession, LoginAttempt, SessionsApi } from '../../core/api/sessions-api';
import { SessionTimer } from '../../core/auth/session-timer';
import { Dialogs } from '../../core/browser/dialogs';

/**
 * The "Bezpieczeństwo" (security) window (opened by the user name in the top bar): time until the session ends, active sessions
 * that can be ended, login history, "Wyloguj pozostałe sesje" (log out other sessions) and "Wyloguj wszędzie" (log out everywhere).
 * Native `<dialog>` with `showModal()`: focus stays in the window, Esc closes it.
 */
@Component({
  selector: 'app-security-dialog',
  templateUrl: './security-dialog.html',
  styleUrl: './security-dialog.scss'
})
export class SecurityDialog {
  private readonly api = inject(SessionsApi);
  private readonly dialogs = inject(Dialogs);
  protected readonly timer = inject(SessionTimer);

  /** Number of unsaved files. "Wyloguj wszędzie" asks about them right away, together with the confirmation. */
  readonly unsavedCount = input(0);
  /**
   * "Wyloguj wszędzie": the other sessions are already ended, and the user has also confirmed discarding unsaved
   * files, so the parent logs out this session without further questions.
   */
  readonly logoutEverywhere = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly sessions = signal<readonly ActiveSession[] | null>(null);
  protected readonly logins = signal<readonly LoginAttempt[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  open(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal();
    }
    void this.load();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected otherSessions(): number {
    return this.sessions()?.filter((s) => !s.current).length ?? 0;
  }

  protected async revoke(session: ActiveSession): Promise<void> {
    await this.run(() => firstValueFrom(this.api.revoke(session.id)), 'Nie udało się zakończyć sesji.');
  }

  protected async revokeOthers(): Promise<void> {
    await this.run(() => firstValueFrom(this.api.revokeOthers()), 'Nie udało się zakończyć pozostałych sesji.');
  }

  protected async everywhere(): Promise<void> {
    // One question before anything: cancelling after ending the other sessions would leave this one logged in.
    const unsaved = this.unsavedCount();
    const question =
      unsaved > 0
        ? `Wylogować wszystkie sesje, także tę? Niezapisane pliki (${unsaved}) zostaną porzucone.`
        : 'Wylogować wszystkie sesje, także tę?';
    if (!this.dialogs.confirm(question)) {
      return;
    }
    const ok = await this.run(() => firstValueFrom(this.api.revokeOthers()), 'Nie udało się zakończyć pozostałych sesji.', false);
    if (ok) {
      this.close();
      this.logoutEverywhere.emit();
    }
  }

  protected date(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      const [sessions, logins] = await Promise.all([firstValueFrom(this.api.list()), firstValueFrom(this.api.logins())]);
      this.sessions.set(sessions);
      this.logins.set(logins);
    } catch {
      this.error.set('Nie udało się wczytać sesji.');
    }
  }

  private async run(action: () => Promise<void>, failure: string, reload = true): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      if (reload) {
        await this.load();
      }
      return true;
    } catch {
      this.error.set(failure);
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
