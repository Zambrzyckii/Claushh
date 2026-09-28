import { DOCUMENT, Injectable, inject } from '@angular/core';

/** Simple browser dialogs. Extracted into a service so they can be replaced in tests. */
@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly view = inject(DOCUMENT).defaultView;

  confirm(message: string): boolean {
    return this.view?.confirm(message) ?? false;
  }
}
