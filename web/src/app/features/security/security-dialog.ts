import { Component, ElementRef, inject, input, output, viewChild } from '@angular/core';

import { Passkey } from './passkeys-api';
import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { Dialogs } from '../../core/browser/dialogs';
import { formatDateTime } from '../../core/text/format';
import { PasskeysStore } from './passkeys-store';
import { SessionsStore } from './sessions-store';

/**
 * The Security window (opened by the user name in the top bar, on a phone from the menu): time until the session
 * ends, active sessions that can be ended, the passkeys (state and changes: PasskeysStore), login history, "Log out
 * other sessions" and "Log out everywhere".
 * Native `<dialog>` with `showModal()`: focus stays in the window, Esc closes it. On a phone it is a full-screen sheet.
 */
@Component({
  selector: 'app-security-dialog',
  providers: [PasskeysStore, SessionsStore],
  templateUrl: './security-dialog.html',
  styleUrl: './security-dialog.scss'
})
export class SecurityDialog {
  private readonly dialogs = inject(Dialogs);
  protected readonly timer = inject(SessionTimer);
  protected readonly layout = inject(DeviceLayout);
  protected readonly passkeys = inject(PasskeysStore);
  protected readonly sessions = inject(SessionsStore);

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

  open(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal();
    }
    void this.sessions.load();
    // Apart from the sessions, so a slow or failing passkey list never holds them up.
    void this.passkeys.load();
  }

  /** Esc comes here too (`(cancel)`), so a typed password and code never stay in the closed window. */
  protected close(): void {
    this.passkeys.cancelReauthentication();
    this.dialog().nativeElement.close();
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
    const ok = await this.sessions.revokeOthers(false);
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

  /**
   * The password and code: nothing is sent until both are filled in;
   * the code is cleared after every attempt, the password also after a refusal.
   */
  protected async reauthenticate(event: Event): Promise<void> {
    event.preventDefault();
    const password = this.reauthPassword()?.nativeElement;
    const code = this.reauthCode()?.nativeElement;
    if (!password || !code) {
      return;
    }
    const outcome = await this.passkeys.reauthenticate(password.value, code.value);
    if (outcome === 'invalid') {
      return;
    }
    code.value = '';
    if (outcome === 'refused') {
      password.value = '';
    }
  }

  protected date(iso: string): string {
    return formatDateTime(iso);
  }
}
