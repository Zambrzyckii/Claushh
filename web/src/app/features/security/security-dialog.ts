import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Passkey } from '../../core/api/passkeys-api';
import { ActiveSession, LoginAttempt, SessionsApi } from '../../core/api/sessions-api';
import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { Dialogs } from '../../core/browser/dialogs';
import { formatDateTime } from '../../core/text/format';
import { PasskeysStore } from './passkeys-store';

/**
 * The Security window (opened by the user name in the top bar, on a phone from the menu): time until the session
 * ends, active sessions that can be ended, the passkeys (state and changes: PasskeysStore), login history, "Log out
 * other sessions" and "Log out everywhere".
 * Native `<dialog>` with `showModal()`: focus stays in the window, Esc closes it. On a phone it is a full-screen sheet.
 */
@Component({
  selector: 'app-security-dialog',
  providers: [PasskeysStore],
  templateUrl: './security-dialog.html',
  styleUrl: './security-dialog.scss'
})
export class SecurityDialog {
  private readonly api = inject(SessionsApi);
  private readonly dialogs = inject(Dialogs);
  protected readonly timer = inject(SessionTimer);
  protected readonly layout = inject(DeviceLayout);
  protected readonly passkeys = inject(PasskeysStore);

  /** Number of unsaved files. "Log out everywhere" asks about them right away, together with the confirmation. */
  readonly unsavedCount = input(0);
  /**
   * "Log out everywhere": the other sessions are already ended, and the user has also confirmed discarding unsaved
   * files, so the parent logs out this session without further questions.
   */
  readonly logoutEverywhere = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly newName = viewChild<ElementRef<HTMLInputElement>>('newName');
  private readonly reauthPassword = viewChild<ElementRef<HTMLInputElement>>('reauthPassword');
  private readonly reauthCode = viewChild<ElementRef<HTMLInputElement>>('reauthCode');

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
    // Apart from the sessions, so a slow or failing passkey list never holds them up.
    void this.passkeys.load();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected otherSessions(): number {
    return this.sessions()?.filter((s) => !s.current).length ?? 0;
  }

  protected async revoke(session: ActiveSession): Promise<void> {
    await this.run(() => firstValueFrom(this.api.revoke(session.id)), 'Could not end the session.');
  }

  protected async revokeOthers(): Promise<void> {
    await this.run(() => firstValueFrom(this.api.revokeOthers()), 'Could not end the other sessions.');
  }

  protected async everywhere(): Promise<void> {
    // One question before anything: cancelling after ending the other sessions would leave this one logged in.
    const unsaved = this.unsavedCount();
    const question =
      unsaved > 0
        ? `Log out every session, this one too? Unsaved files (${unsaved}) will be discarded.`
        : 'Log out every session, this one too?';
    if (!this.dialogs.confirm(question)) {
      return;
    }
    const ok = await this.run(() => firstValueFrom(this.api.revokeOthers()), 'Could not end the other sessions.', false);
    if (ok) {
      this.close();
      this.logoutEverywhere.emit();
    }
  }

  protected async addPasskey(event: Event): Promise<void> {
    event.preventDefault();
    await this.passkeys.add();
  }

  protected async renamePasskey(event: Event, passkey: Passkey): Promise<void> {
    event.preventDefault();
    const input = this.newName()?.nativeElement;
    if (input) {
      await this.passkeys.rename(passkey, input.value);
    }
  }

  protected async removePasskey(passkey: Passkey): Promise<void> {
    if (this.dialogs.confirm(`Remove the passkey “${passkey.name}”? It can no longer be used to log in.`)) {
      await this.passkeys.remove(passkey);
    }
  }

  /** The password and code: the code is cleared after every attempt, the password also after a refusal. */
  protected async reauthenticate(event: Event): Promise<void> {
    event.preventDefault();
    const password = this.reauthPassword()?.nativeElement;
    const code = this.reauthCode()?.nativeElement;
    if (!password || !code) {
      return;
    }
    const outcome = await this.passkeys.reauthenticate(password.value, code.value);
    code.value = '';
    if (outcome === 'refused') {
      password.value = '';
    }
  }

  protected date(iso: string): string {
    return formatDateTime(iso);
  }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      const [sessions, logins] = await Promise.all([firstValueFrom(this.api.list()), firstValueFrom(this.api.logins())]);
      this.sessions.set(sessions);
      this.logins.set(logins);
    } catch {
      this.error.set('Could not load the sessions.');
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
