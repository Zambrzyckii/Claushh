import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ActiveSession, LoginAttempt, SessionsApi } from './sessions-api';

/**
 * The sessions in the Security window (docs/ARCHITECTURE.md, section "Sessions and login history"). It loads the
 * active sessions and the login history together and ends one session or all the others, one action at a time, with
 * the failure's text in `error`. Provided in the Security window, which keeps the markup, like PasskeysStore.
 */
@Injectable()
export class SessionsStore {
  private readonly api = inject(SessionsApi);

  readonly list = signal<readonly ActiveSession[] | null>(null);
  readonly logins = signal<readonly LoginAttempt[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  otherSessions(): number {
    return this.list()?.filter((s) => !s.current).length ?? 0;
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      const [sessions, logins] = await Promise.all([firstValueFrom(this.api.list()), firstValueFrom(this.api.logins())]);
      this.list.set(sessions);
      this.logins.set(logins);
    } catch {
      this.error.set('Could not load the sessions.');
    }
  }

  async revoke(session: ActiveSession): Promise<void> {
    await this.run(() => firstValueFrom(this.api.revoke(session.id)), 'Could not end the session.');
  }

  revokeOthers(reload = true): Promise<boolean> {
    return this.run(() => firstValueFrom(this.api.revokeOthers()), 'Could not end the other sessions.', reload);
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
