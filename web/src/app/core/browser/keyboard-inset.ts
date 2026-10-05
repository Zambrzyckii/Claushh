import { DOCUMENT, Injectable, effect, inject } from '@angular/core';

import { DeviceLayout } from './device-layout';

/**
 * Keeps the phone view above the soft keyboard on iOS (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"): Safari does
 * not resize the page for the keyboard, so while the phone layout is on this sets --keyboard-inset on <html> to the part
 * of the layout viewport the keyboard covers, and 0px otherwise. Android resizes the page itself (interactive-widget),
 * so the inset stays 0 there. Without visualViewport (jsdom) it does nothing.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardInset {
  constructor() {
    const document = inject(DOCUMENT);
    const layout = inject(DeviceLayout);
    const view = document.defaultView;
    const viewport = view?.visualViewport;
    if (!view || !viewport) {
      return;
    }
    const root = document.documentElement;
    const update = () => {
      const covered = Math.max(0, view.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty('--keyboard-inset', `${covered}px`);
    };
    effect((onCleanup) => {
      if (!layout.phone()) {
        root.style.setProperty('--keyboard-inset', '0px');
        return;
      }
      update();
      viewport.addEventListener('resize', update);
      viewport.addEventListener('scroll', update);
      onCleanup(() => {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
      });
    });
  }
}
