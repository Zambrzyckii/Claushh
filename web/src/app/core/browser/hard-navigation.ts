import { DOCUMENT, Injectable, inject } from '@angular/core';

/**
 * Full page reload (outside the Angular router).
 *
 * Used on logout and session expiry: a new document means that the whole app state disappears
 * from memory (services, signals, later also open files in the editor and SignalR connections).
 * `replace` leaves no history entry, so "Back" does not return to the logged-in view.
 * Extracted into a service so it can be replaced in tests.
 */
@Injectable({ providedIn: 'root' })
export class HardNavigation {
  private readonly document = inject(DOCUMENT);

  replace(url: string): void {
    this.document.location.replace(url);
  }

  /** Current address in the app (path + query + hash), e.g. for `returnUrl`. */
  currentUrl(): string {
    const { pathname, search, hash } = this.document.location;
    return pathname + search + hash;
  }
}
