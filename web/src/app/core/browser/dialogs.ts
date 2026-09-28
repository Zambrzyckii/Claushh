import { DOCUMENT, Injectable, inject } from '@angular/core';

/**
 * Simple browser dialogs. Extracted into a service so they can be replaced in tests.
 * They block the page (including the session countdown), so they may be used only in response to a user action,
 * never on their own (e.g. after a reconnect).
 */
@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly view = inject(DOCUMENT).defaultView;

  confirm(message: string): boolean {
    return this.view?.confirm(message) ?? false;
  }

  alert(message: string): void {
    this.view?.alert(message);
  }
}
