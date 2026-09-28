import { DOCUMENT, inject } from '@angular/core';

/**
 * Disables restoring the page from the back/forward cache.
 *
 * Without this, after logout the "Back" button could restore from the browser's memory
 * the previous document together with its whole state (e.g. open code). When the page comes back
 * from bfcache (`event.persisted`), we reload it, so it goes through the guard normally.
 * Registered in `app.config.ts` via `provideAppInitializer`.
 */
export function installBfcacheGuard(): void {
  const view = inject(DOCUMENT).defaultView;
  view?.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (event.persisted) {
      view.location.reload();
    }
  });
}
