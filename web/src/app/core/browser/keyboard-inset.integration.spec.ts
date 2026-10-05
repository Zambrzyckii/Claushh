import { TestBed } from '@angular/core/testing';

import { PHONE_QUERY } from './device-layout';
import { KeyboardInset } from './keyboard-inset';

/**
 * Integration: the real DeviceLayout and KeyboardInset. Only the browser boundary is replaced: matchMedia (the phone
 * query) and visualViewport, which jsdom does not have.
 */

class FakeMediaQueryList extends EventTarget {
  constructor(public matches: boolean) {
    super();
  }

  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(Object.assign(new Event('change'), { matches }));
  }
}

describe('KeyboardInset (integration)', () => {
  const view = document.defaultView!;
  const saved = new Map<string, PropertyDescriptor | undefined>();

  function stub(name: string, value: unknown): void {
    saved.set(name, Object.getOwnPropertyDescriptor(view, name));
    Object.defineProperty(view, name, { configurable: true, writable: true, value });
  }

  afterEach(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(view, name, descriptor);
      } else {
        delete (view as unknown as Record<string, unknown>)[name];
      }
    }
    saved.clear();
    document.documentElement.style.removeProperty('--keyboard-inset');
    TestBed.resetTestingModule();
  });

  it('sets --keyboard-inset from the visual viewport while the phone layout is on, and 0px after it ends', () => {
    const phone = new FakeMediaQueryList(true);
    stub('matchMedia', (query: string) => (query === PHONE_QUERY ? phone : new FakeMediaQueryList(false)));
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    stub('visualViewport', viewport);
    stub('innerHeight', 800);
    const inset = () => document.documentElement.style.getPropertyValue('--keyboard-inset');

    TestBed.configureTestingModule({});
    TestBed.inject(KeyboardInset);
    TestBed.tick();
    expect(inset()).toBe('0px');

    viewport.height = 460;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('300px');

    phone.change(false);
    TestBed.tick();
    expect(inset()).toBe('0px');
    viewport.height = 300;
    viewport.dispatchEvent(new Event('resize'));
    expect(inset()).toBe('0px');
  });
});
