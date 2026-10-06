import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Passkey, PasskeyApiError, PasskeysApi } from '../../core/api/passkeys-api';
import { WebAuthn, WebAuthnFailure } from '../../core/browser/webauthn';
import { formatWait } from '../../core/text/format';

/** The backend's name rule, word for word (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"). */
const NAME_RULE = 'A passkey name has 1 to 64 characters and no control characters.';
const NOT_ADDED = 'The passkey could not be added. Try again.';

/** How the password and code ended: the waiting change ran, the server refused them (`403`), or another failure. */
export type ReauthOutcome = 'done' | 'refused' | 'failed';

/** A change of the passkeys and its message when it fails. */
interface Change {
  action: () => Promise<void>;
  failure: string;
}

/**
 * The passkeys in the Security window (docs/ARCHITECTURE.md, "Authentication" → "Passkeys"): the list, adding,
 * renaming and removing. Adding and removing need the password and a code again: when the server answers `403`, the
 * change waits for the form and runs once more after it (the server then allows changes for 5 minutes). Provided in
 * the Security window, which keeps the markup, so the phone's card layout applies to the passkeys too.
 */
@Injectable()
export class PasskeysStore {
  private readonly api = inject(PasskeysApi);
  private readonly webAuthn = inject(WebAuthn);

  /** Whether this browser can create passkeys; the list, renaming and removing work without it. */
  readonly canCreate = this.webAuthn.available();
  readonly list = signal<readonly Passkey[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  /** The name for the next passkey; empty: the server names it after the device, e.g. "Chrome · Linux". */
  readonly newName = signal('');
  /** The id of the passkey being renamed. */
  readonly renaming = signal<string | null>(null);
  private readonly waiting = signal<Change | null>(null);
  /** A change waits for the password and code. */
  readonly askingForPassword = computed(() => this.waiting() !== null);

  /** When the window opens: the list, and nothing left over from before. */
  async load(): Promise<void> {
    this.error.set(null);
    this.newName.set('');
    this.renaming.set(null);
    this.waiting.set(null);
    await this.refresh();
  }

  /** The creation options, the browser's prompt, then the new passkey to the server. A cancelled prompt sends nothing. */
  async add(): Promise<void> {
    const name = this.newName().trim();
    if (name !== '' && !validName(name)) {
      this.error.set(NAME_RULE);
      return;
    }
    await this.run({
      action: async () => {
        const options = await firstValueFrom(this.api.creationOptions());
        const created = await this.webAuthn.create(options);
        if (!created.ok) {
          this.error.set(promptFailure(created.reason));
          return;
        }
        await firstValueFrom(this.api.add(created.credential, name === '' ? null : name));
        this.newName.set('');
        await this.refresh();
      },
      failure: NOT_ADDED
    });
  }

  startRenaming(passkey: Passkey): void {
    this.error.set(null);
    this.renaming.set(passkey.id);
  }

  async rename(passkey: Passkey, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!validName(trimmed)) {
      this.error.set(NAME_RULE);
      return;
    }
    await this.run({
      action: async () => {
        await firstValueFrom(this.api.rename(passkey.id, trimmed));
        this.renaming.set(null);
        await this.refresh();
      },
      failure: 'Could not rename the passkey.'
    });
  }

  async remove(passkey: Passkey): Promise<void> {
    await this.run({
      action: async () => {
        await firstValueFrom(this.api.remove(passkey.id));
        await this.refresh();
      },
      failure: 'Could not remove the passkey.'
    });
  }

  /** The form's password and code; after a success the waiting change runs once more. */
  async reauthenticate(password: string, totpCode: string): Promise<ReauthOutcome> {
    const change = this.waiting();
    if (change === null || this.busy()) {
      return 'failed';
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.reauthenticate(password, totpCode));
    } catch (error) {
      const refused = error instanceof PasskeyApiError && error.kind === 'forbidden';
      this.error.set(refused ? 'Wrong password or code.' : errorText(error, 'Could not check the password and code.'));
      return refused ? 'refused' : 'failed';
    } finally {
      this.busy.set(false);
    }
    this.waiting.set(null);
    await this.run(change);
    return 'done';
  }

  cancelReauthentication(): void {
    this.waiting.set(null);
    this.error.set(null);
  }

  /**
   * One change at a time. A `403` keeps it for after the password and code; a `404` means the passkey is gone, so
   * the list loads again.
   */
  private async run(change: Change): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await change.action();
    } catch (error) {
      if (error instanceof PasskeyApiError && error.kind === 'forbidden') {
        this.waiting.set(change);
      } else if (error instanceof PasskeyApiError && error.kind === 'not-found') {
        this.renaming.set(null);
        await this.refresh();
      } else {
        this.error.set(errorText(error, change.failure));
      }
    } finally {
      this.busy.set(false);
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.list.set(await firstValueFrom(this.api.list()));
    } catch {
      this.error.set('Could not load the passkeys.');
    }
  }
}

/** The backend's rule: trimmed, 1-64 UTF-16 units, no control or format characters (names go into notifications). */
function validName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(name);
}

function promptFailure(reason: WebAuthnFailure): string {
  switch (reason) {
    case 'cancelled':
      return 'Cancelled.';
    case 'already-registered':
      return 'This device already has a passkey for the portal.';
    case 'not-here':
      return "Passkeys work only at the portal's domain name.";
    case 'failed':
      return NOT_ADDED;
  }
}

/** The server's text for `400` and `409`, the wait for `429`; otherwise the change's own failure. */
function errorText(error: unknown, failure: string): string {
  if (!(error instanceof PasskeyApiError)) {
    return failure;
  }
  switch (error.kind) {
    case 'invalid':
    case 'conflict':
      return error.detail ?? failure;
    case 'rate-limited':
      return error.retryAfterSeconds
        ? `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}`
        : 'Too many attempts. Try again later.';
    case 'network':
      return 'No connection to the server.';
    default:
      return failure;
  }
}
