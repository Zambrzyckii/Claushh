import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';

import { authGuard, guestGuard } from '../../core/auth/auth.guards';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { AUTH_API } from '../../core/auth/auth.service';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { Login } from './login';

/**
 * Integration: the screen after an unconfirmed logout. Real routes with guards, AuthService, interceptor
 * and the login component. Only HTTP (HttpTestingController), the page reload and the clock are replaced.
 * The unconfirmed logout marker (`localStorage`) is set by the test the same way AuthService does before the reload.
 */

/** Marker key from AuthService (`PENDING_LOGOUT_KEY`). */
const PENDING_LOGOUT_KEY = 'claushh-pending-logout';

@Component({ template: 'aplikacja' })
class App {}

describe('Unconfirmed logout (integration)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', canActivate: [guestGuard], component: Login },
          { path: '', canActivate: [authGuard], component: App }
        ]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: HardNavigation, useValue: { replace: vi.fn(), currentUrl: () => '/' } }
      ]
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      // Cleanup also after a failed `verify`, so that one error does not break the following tests.
      vi.restoreAllMocks();
      vi.useRealTimers();
      localStorage.clear();
      TestBed.resetTestingModule();
    }
  });

  async function open(url: string) {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const render = async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms);
      harness.detectChanges();
    };
    return { harness, render, root: harness.routeNativeElement as HTMLElement };
  }

  const notice = (root: HTMLElement) => root.querySelector('[role="status"]')!.textContent!.trim();

  const me = (sessionId: string) => ({ userName: 'owner', sessionId, expiresIn: 1800, absoluteExpiresIn: 3600 });
  const confirmed = 'Wylogowano. Serwer potwierdził zakończenie sesji.';

  it('stays on the login page even though the session is still alive, and ends exactly that session', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    expect(TestBed.inject(Router).url).toBe('/login?logout=unconfirmed');
    expect(notice(root)).toContain('serwer nie potwierdził');

    // The screen retries the logout on its own: the same session is still alive (200), so POST /logout goes out with its identifier.
    http.expectOne(AUTH_API.me).flush(me('s1'));
    await render();
    const logout = http.expectOne(AUTH_API.logout);
    expect(logout.request.body).toEqual({ sessionId: 's1' });
    logout.flush(null, { status: 204, statusText: 'No Content' });
    await render();

    expect(TestBed.inject(Router).url).toBe('/login?logout=unconfirmed');
    expect(notice(root)).toBe(confirmed);
    expect(root.textContent).not.toContain('Ponów wylogowanie');
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
    await render(20_000);
    http.expectNone(AUTH_API.me); // after confirmation the retry ends
  });

  it('ends only the old session when the browser has meanwhile logged in again, then goes to the app', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render } = await open('/login?logout=unconfirmed');
    // The cookie already belongs to the new session s2 (login in another tab): we end s1 by identifier, s2 stays.
    http.expectOne(AUTH_API.me).flush(me('s2'));
    await render();
    const revoke = http.expectOne('/api/auth/sessions/s1');
    expect(revoke.request.method).toBe('DELETE');
    revoke.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectNone(AUTH_API.logout);
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
    // This is not "Wylogowano": the browser has a live session s2, so as with every login screen with a session — on to the app.
    http.expectOne(AUTH_API.me).flush(me('s2')); // app guard
    await render();
    expect(TestBed.inject(Router).url).toBe('/');
    await render(60_000);
    http.expectNone(AUTH_API.me); // end of retry
  });

  it('a logout that the server refuses because the session changed is retried', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).flush(me('s1'));
    await render();
    // Between GET /me and POST /logout someone logged in again: the server ends nothing (409).
    http.expectOne(AUTH_API.logout).flush(null, { status: 409, statusText: 'Conflict' });
    await render();
    expect(notice(root)).toContain('serwer nie potwierdził');

    await render(3_000);
    http.expectOne(AUTH_API.me).flush(me('s2'));
    await render();
    http.expectOne('/api/auth/sessions/s1').flush(null, { status: 404, statusText: 'Not Found' });
    await render();
    http.expectNone(AUTH_API.logout); // nothing ends the new session s2
    http.expectOne(AUTH_API.me).flush(me('s2')); // app guard
    await render();
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('when the marker disappears and the browser has a new session, the page goes to the app and ends nothing', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render } = await open('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).error(new ProgressEvent('error'));
    await render();
    localStorage.removeItem(PENDING_LOGOUT_KEY); // another tab logged in and finished the logout of s1
    await render(3_000);
    http.expectOne(AUTH_API.me).flush(me('s2')); // only a check
    await render();
    http.expectOne(AUTH_API.me).flush(me('s2')); // app guard
    await render();
    expect(TestBed.inject(Router).url).toBe('/');
    await render(60_000);
    http.expectNone(AUTH_API.me);
    http.expectNone(AUTH_API.logout);
    http.expectNone((r) => r.method === 'DELETE');
  });

  it('keeps retrying while the server is unreachable and offers a manual retry', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).error(new ProgressEvent('error'));
    await render(3_000);
    http.expectOne(AUTH_API.me).error(new ProgressEvent('error'));
    await render(7_000);
    http.expectOne(AUTH_API.me).error(new ProgressEvent('error'));
    await render();
    expect(notice(root)).toContain('serwer nie potwierdził');

    button(root, 'Ponów wylogowanie').click();
    await render();
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
    await render();
    expect(notice(root)).toBe(confirmed);
  });

  it('a link from outside to the unconfirmed-logout page logs nobody out and, with a live session, leads to the app', async () => {
    // Without the app marker this URL is checked like every login screen.
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login?logout=unconfirmed');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(me('s1'));
    await navigation;
    expect(TestBed.inject(Router).url).toBe('/');
    await vi.advanceTimersByTimeAsync(20_000);
    http.expectNone(AUTH_API.logout);
  });

  it('without the marker the page only checks that the session is gone (another tab finished the logout)', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login?logout=unconfirmed');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' }); // guard
    await navigation;
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' }); // check on the screen
    await vi.advanceTimersByTimeAsync(0);
    harness.detectChanges();
    expect(notice(harness.routeNativeElement as HTMLElement)).toBe(confirmed);
    http.expectNone(AUTH_API.logout);
  });

  it('with an unknown session id nothing is ended automatically, only by the button', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, '');
    const { render, root } = await open('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).flush(me('s1')); // only a check whether the session is already gone: it is not
    await render(20_000);
    http.expectNone(AUTH_API.me);
    http.expectNone(AUTH_API.logout);

    button(root, 'Ponów wylogowanie').click();
    await render();
    http.expectOne(AUTH_API.me).flush(me('s1'));
    await render();
    const logout = http.expectOne(AUTH_API.logout);
    expect(logout.request.body).toBeNull();
    logout.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    expect(notice(root)).toBe(confirmed);
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
  });

  it('when the browser blocks storage, the page still shows the warning and the button ends the session', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });
    const { render, root } = await open('/login?logout=unconfirmed&marker=none');
    expect(TestBed.inject(Router).url).toBe('/login?logout=unconfirmed&marker=none'); // no redirect to the app
    http.expectOne(AUTH_API.me).flush(me('s1')); // only a check whether the session is already gone: it is not
    await render(20_000);
    http.expectNone(AUTH_API.me); // apart from that nothing happens on its own
    http.expectNone(AUTH_API.logout);
    expect(notice(root)).toContain('serwer nie potwierdził');

    button(root, 'Ponów wylogowanie').click();
    await render();
    http.expectOne(AUTH_API.me).flush(me('s1'));
    await render();
    http.expectOne(AUTH_API.logout).flush(null, { status: 204, statusText: 'No Content' });
    await render();
    expect(notice(root)).toBe(confirmed);
  });

  it('"marker=none" from a link does nothing special when storage works', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login?logout=unconfirmed&marker=none');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(me('s1')); // regular login screen: the session is alive, so on to the app
    await navigation;
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('a tab that was already asking the server when another tab failed to log out does not enter the app', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/');
    await vi.advanceTimersByTimeAsync(0);
    const check = http.expectOne(AUTH_API.me);
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1'); // meanwhile another tab: unconfirmed logout
    check.flush(me('s1'));
    await navigation;
    expect(TestBed.inject(Router).url).toBe('/login?logout=unconfirmed');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' }); // retry from the screen
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a newer unconfirmed logout from another tab is finished too before the page says it is done', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    const first = http.expectOne(AUTH_API.me);
    localStorage.setItem(PENDING_LOGOUT_KEY, 's2'); // another tab: also an unconfirmed logout, this time of session s2
    first.flush(me('s2'));
    await render();
    http.expectOne('/api/auth/sessions/s1').flush(null, { status: 404, statusText: 'Not Found' });
    await render();
    expect(notice(root)).toContain('serwer nie potwierdził'); // s2 is still alive
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBe('s2');

    await render(3_000);
    http.expectOne(AUTH_API.me).flush(me('s2'));
    await render();
    const logout = http.expectOne(AUTH_API.logout);
    expect(logout.request.body).toEqual({ sessionId: 's2' });
    logout.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    expect(notice(root)).toBe(confirmed);
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
  });

  it('logging in waits for a retry in flight, and a late retry cannot end the new session', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    const retry = http.expectOne(AUTH_API.me); // retry in progress

    fill(root, 'userName', 'owner');
    fill(root, 'password', 'secret');
    fill(root, 'totpCode', '123456');
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await render();
    http.expectNone(AUTH_API.login); // login waits for the retry to end
    expect(http.match(AUTH_API.me)).toHaveLength(0); // also its GET /me for the XSRF token

    retry.flush(me('s1'));
    await render();
    http.expectNone(AUTH_API.me); // login still waits (its own GET /me has not gone out yet)
    http.expectOne(AUTH_API.logout).flush(null, { status: 204, statusText: 'No Content' });
    await render();
    // Login always fetches a fresh XSRF token first.
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
    await render();
    http.expectOne(AUTH_API.login).flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectOne(AUTH_API.me).flush(me('s2'));
    await render();
    expect(TestBed.inject(Router).url).toBe('/');

    await render(20_000);
    http.expectNone(AUTH_API.logout);
    http.expectNone((r) => r.method === 'DELETE');
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
  });

  it('while the logout is unconfirmed, neither Back to the app nor a new tab lets anyone in', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/?repo=studia%2Flab');
    // The guard does not ask the server (the session may have survived), it only sends to the screen that ends that session.
    expect(TestBed.inject(Router).url).toBe('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' }); // this is already the retry from the screen
    await vi.advanceTimersByTimeAsync(0);
  });

  it('while the logout is unconfirmed, an older login page does not send a live session to the app', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login?returnUrl=%2F');
    expect(TestBed.inject(Router).url).toBe('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).flush(me('s1')); // retry from the screen: the session is alive, so logout
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.logout).flush(null, { status: 204, statusText: 'No Content' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('keeps retrying every 30 s until the server confirms', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    for (const wait of [0, 3_000, 7_000, 30_000, 30_000]) {
      await render(wait);
      http.expectOne(AUTH_API.me).error(new ProgressEvent('error'));
    }
    await render(29_000);
    http.expectNone(AUTH_API.me);
    await render(1_000);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
    await render();
    expect(notice(root)).toBe(confirmed);
  });

  it('logging in while the old session is still pending ends it from the new session', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed');
    http.expectOne(AUTH_API.me).error(new ProgressEvent('error')); // the server is not responding yet
    await render();

    fill(root, 'userName', 'owner');
    fill(root, 'password', 'secret');
    fill(root, 'totpCode', '123456');
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await render();
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
    await render();
    http.expectOne(AUTH_API.login).flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectOne(AUTH_API.me).flush(me('s2'));
    await render();
    const revoke = http.expectOne('/api/auth/sessions/s1');
    expect(revoke.request.method).toBe('DELETE');
    revoke.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    expect(TestBed.inject(Router).url).toBe('/');
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull();
  });

  it('a normal visit to the login page with a live session still goes to the app', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(me('s1'));
    await navigation;
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('the page after a confirmed logout asks the server as usual (and gets a fresh XSRF token)', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login?logout=ok');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
    await navigation;
    expect(TestBed.inject(Router).url).toBe('/login?logout=ok');
  });
});

function button(root: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent!.includes(label))!;
}

function fill(root: HTMLElement, id: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
