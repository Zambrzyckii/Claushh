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
import { WebAuthn } from '../../core/browser/webauthn';
import { Login } from './login';

/**
 * Integration: the passkey button of the login screen. Real routes with guards, AuthService, interceptor and the login
 * component; only HTTP (HttpTestingController), the page reload, the clock and the browser's passkey prompt (WebAuthn)
 * are replaced. Whether the prompt holds the login lock is checked in e2e (jsdom has no Web Locks).
 */

@Component({ template: 'app' })
class App {}

const REQUEST_OPTIONS = {
  challenge: 'Y2hhbGxlbmdl',
  rpId: 'localhost',
  allowCredentials: [],
  userVerification: 'required',
  timeout: 300000
};
const ASSERTION = {
  id: 'k1',
  rawId: 'k1',
  type: 'public-key',
  authenticatorAttachment: 'platform',
  clientExtensionResults: {},
  response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'MEU', userHandle: 'bW9jay1vd25lcg' }
};
const UNAUTHORIZED = { status: 401, statusText: 'Unauthorized' };
const me = (sessionId: string) => ({ userName: 'owner', sessionId, expiresIn: 1800, absoluteExpiresIn: 3600 });

describe('Passkey login (integration)', () => {
  let http: HttpTestingController;
  let navigation: { replace: ReturnType<typeof vi.fn>; currentUrl: () => string };
  let webAuthn: {
    available: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    navigation = { replace: vi.fn(), currentUrl: () => '/' };
    webAuthn = { available: vi.fn(() => true), create: vi.fn(), get: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', canActivate: [guestGuard], component: Login },
          { path: '', canActivate: [authGuard], component: App }
        ]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: HardNavigation, useValue: navigation },
        { provide: WebAuthn, useValue: webAuthn }
      ]
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      localStorage.clear();
      TestBed.resetTestingModule();
    }
  });

  async function openLogin(url = '/login') {
    const harness = await RouterTestingHarness.create();
    const navigated = harness.navigateByUrl(url);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, UNAUTHORIZED); // guestGuard: no session
    await navigated;
    const root = harness.routeNativeElement as HTMLElement;
    const render = async () => {
      await vi.advanceTimersByTimeAsync(0);
      harness.detectChanges();
    };
    return { root, render };
  }

  /** Clicks the passkey button and answers its fresh XSRF token's `GET /me`; the options request is the test's. */
  async function startPasskeyLogin(root: HTMLElement, render: () => Promise<void>): Promise<void> {
    passkeyButton(root)!.click();
    await render();
    http.expectOne(AUTH_API.me).flush(null, UNAUTHORIZED);
    await render();
  }

  const alert = (root: HTMLElement) => root.querySelector('[role="alert"]')?.textContent?.trim() ?? null;

  it('hides the passkey button where the browser cannot use passkeys', async () => {
    webAuthn.available.mockReturnValue(false);
    const { root } = await openLogin();
    expect(passkeyButton(root)).toBeUndefined();
    expect(root.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('logs in with a passkey: nothing else is sent while the prompt is open, then the login, the broadcast and the return address', async () => {
    const broadcast = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
    let answer!: (result: unknown) => void;
    webAuthn.get.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { root, render } = await openLogin('/login?returnUrl=%2F%3Frepo%3Dstudia%252Flab');
    await startPasskeyLogin(root, render);
    const options = http.expectOne(AUTH_API.passkeyLoginOptions);
    expect(options.request.method).toBe('POST');
    options.flush(REQUEST_OPTIONS);
    await render();

    expect(webAuthn.get).toHaveBeenCalledExactlyOnceWith(REQUEST_OPTIONS);
    await render();
    http.expectNone(AUTH_API.me);
    http.expectNone(AUTH_API.passkeyLogin);
    expect(passkeyButton(root)!.disabled).toBe(true);

    answer({ ok: true, credential: ASSERTION });
    await render();
    http.expectOne(AUTH_API.me).flush(null, UNAUTHORIZED); // a fresh XSRF token again
    await render();
    const login = http.expectOne(AUTH_API.passkeyLogin);
    expect(login.request.body).toEqual({ credential: ASSERTION });
    login.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectOne(AUTH_API.me).flush(me('s2')); // the session works
    await render();

    expect(broadcast).toHaveBeenCalledWith({ type: 'session', sessionId: 's2' });
    expect(TestBed.inject(Router).url).toBe('/?repo=studia%2Flab');
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', 'Passkey login cancelled.'],
    ['not-here', "Passkeys work only at the portal's domain name."],
    ['failed', 'The passkey could not be used.']
  ])('a prompt that ends with "%s" shows "%s" and sends no login', async (reason, message) => {
    webAuthn.get.mockResolvedValue({ ok: false, reason });
    const { root, render } = await openLogin();
    await startPasskeyLogin(root, render);
    http.expectOne(AUTH_API.passkeyLoginOptions).flush(REQUEST_OPTIONS);
    await render();
    expect(alert(root)).toBe(message);
    http.expectNone(AUTH_API.passkeyLogin);
    expect(passkeyButton(root)!.disabled).toBe(false);
  });

  it('a refused passkey shows a message and does not reload the page', async () => {
    webAuthn.get.mockResolvedValue({ ok: true, credential: ASSERTION });
    const { root, render } = await openLogin();
    await startPasskeyLogin(root, render);
    http.expectOne(AUTH_API.passkeyLoginOptions).flush(REQUEST_OPTIONS);
    await render();
    http.expectOne(AUTH_API.me).flush(null, UNAUTHORIZED);
    await render();
    http.expectOne(AUTH_API.passkeyLogin).flush(null, UNAUTHORIZED);
    await render();
    expect(alert(root)).toBe('The passkey was not accepted.');
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(TestBed.inject(Router).url).toBe('/login');
  });

  it('too many attempts show the wait, and a lost connection says so', async () => {
    const { root, render } = await openLogin();
    await startPasskeyLogin(root, render);
    http
      .expectOne(AUTH_API.passkeyLoginOptions)
      .flush(null, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '30' } });
    await render();
    expect(alert(root)).toBe('Too many attempts. Try again in 30 s.');

    await startPasskeyLogin(root, render);
    http.expectOne(AUTH_API.passkeyLoginOptions).error(new ProgressEvent('error'));
    await render();
    expect(alert(root)).toBe('No connection to the server.');
    expect(webAuthn.get).not.toHaveBeenCalled();
  });

  it('a passkey login waits for a logout retry in flight', async () => {
    localStorage.setItem('claushh-pending-logout', 's1');
    webAuthn.get.mockResolvedValue({ ok: false, reason: 'cancelled' });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login?logout=unconfirmed');
    const root = harness.routeNativeElement as HTMLElement;
    const render = async () => {
      await vi.advanceTimersByTimeAsync(0);
      harness.detectChanges();
    };
    const retry = http.expectOne(AUTH_API.me); // the screen retries the logout

    passkeyButton(root)!.click();
    await render();
    http.expectNone(AUTH_API.me);
    http.expectNone(AUTH_API.passkeyLoginOptions);
    retry.flush(me('s1'));
    await render();
    http.expectOne(AUTH_API.logout).flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectOne(AUTH_API.me).flush(null, UNAUTHORIZED); // only now the passkey login's fresh XSRF token
    await render();
    http.expectOne(AUTH_API.passkeyLoginOptions).flush(REQUEST_OPTIONS);
    await render();
    expect(alert(root)).toBe('Passkey login cancelled.');
  });
});

function passkeyButton(root: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent!.includes('Log in with a passkey'));
}
