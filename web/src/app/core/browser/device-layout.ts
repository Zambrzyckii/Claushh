import { DOCUMENT, Injectable, Signal, inject, signal } from '@angular/core';

/**
 * Which layout the page uses (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"): `phone` for a narrow window or a phone
 * in landscape, `touch` for a coarse pointer (also a tablet in the desktop layout). A service, so tests replace it the
 * way they replace Dialogs; without matchMedia (jsdom) both are false.
 */
export const PHONE_QUERY = '(max-width: 767.98px), (pointer: coarse) and (max-height: 500px)';
export const TOUCH_QUERY = '(pointer: coarse)';

@Injectable({ providedIn: 'root' })
export class DeviceLayout {
  private readonly view = inject(DOCUMENT).defaultView;

  readonly phone: Signal<boolean> = this.watch(PHONE_QUERY);
  readonly touch: Signal<boolean> = this.watch(TOUCH_QUERY);

  private watch(query: string): Signal<boolean> {
    const list = this.view?.matchMedia?.(query);
    const matches = signal(list?.matches ?? false);
    list?.addEventListener('change', (event) => matches.set(event.matches));
    return matches.asReadonly();
  }
}
