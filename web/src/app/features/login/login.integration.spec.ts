import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';

import { authGuard, guestGuard } from '../../core/auth/auth.guards';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { AUTH_API, AuthService } from '../../core/auth/auth.service';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { Login } from './login';

/**
 * Integration: the login screen. Real routes with guards, AuthService, the interceptor and the login component.
 * Only HTTP (HttpTestingController), the page reload and the clock are replaced, and the page after the login is a
 * stub, because the real workbench would start the hubs, the stores and Monaco's loader.
 * The unconfirmed logout marker (`localStorage`) is set by the test the same way AuthService does before the reload.
 */

/** Marker key from AuthService (`PENDING_LOGOUT_KEY`). */
const PENDING_LOGOUT_KEY = 'claushh-pending-logout';

@Component({ template: 'workbench' })
class StubPage {}

describe('Login (integration)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', canActivate: [guestGuard], component: Login },
          { path: '', canActivate: [authGuard], component: StubPage },
          { path: '**', canActivate: [authGuard], component: StubPage }
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

  const me = { userName: 'owner', sessionId: 's1', expiresIn: 1800, absoluteExpiresIn: 43200 };
  const unauthorized = 401;
  const noContent = 204;

  /** Waits for the first request to the URL, then takes every pending one. */
  async function pending(url: string): Promise<TestRequest[]> {
    return vi.waitFor(() => {
      const requests = http.match(url);
      expect(requests.length).toBeGreaterThan(0);
      return requests;
    });
  }

  /** Answers every pending request to the URL with a body, an error status or a network error. */
  async function answer(url: string, bodyOrStatus: object | number | ProgressEvent) {
    const requests = await pending(url);
    for (const request of requests) {
      if (typeof bodyOrStatus === 'number') {
        request.flush(null, { status: bodyOrStatus, statusText: 'Error' });
      } else if (bodyOrStatus instanceof ProgressEvent) {
        request.error(bodyOrStatus);
      } else {
        request.flush(bodyOrStatus);
      }
    }
    return requests;
  }

  async function open(url: string, { sessionCheck = true } = {}) {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl(url);
    if (sessionCheck) {
      await answer(AUTH_API.me, unauthorized); // guestGuard: no session
    }
    await navigation;
    const render = async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms);
      harness.detectChanges();
    };
    return { render, root: harness.routeNativeElement as HTMLElement };
  }

  function fill(root: HTMLElement, id: string, value: string) {
    const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  /** Opens `/login` (with the return address, when given), fills the form and submits it. The caller answers the fresh XSRF check. */
  async function submitLogin(returnUrl?: string, totpCode = '123456') {
    const query = returnUrl === undefined ? '' : `?returnUrl=${encodeURIComponent(returnUrl)}`;
    const screen = await open(`/login${query}`);
    fill(screen.root, 'userName', 'owner');
    fill(screen.root, 'password', 'secret');
    fill(screen.root, 'totpCode', totpCode);
    screen.root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await screen.render();
    return screen;
  }

  /** The whole login: the form, the fresh XSRF check (401), the login (204) and the session check (200). */
  async function logIn(returnUrl?: string) {
    const screen = await submitLogin(returnUrl);
    await answer(AUTH_API.me, unauthorized);
    const [request] = await answer(AUTH_API.login, noContent);
    await answer(AUTH_API.me, me);
    await screen.render();
    return { ...screen, request: request.request };
  }

  /** The form after a refused or failed login: the fresh XSRF check answered, the login left to the test. */
  async function submitAndCheck() {
    const screen = await submitLogin();
    await answer(AUTH_API.me, unauthorized);
    return screen;
  }

  const url = () => TestBed.inject(Router).url;
  const alertText = (root: HTMLElement) => root.querySelector('[role="alert"]')!.textContent;
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!.value;

  it('does not send an incomplete form', async () => {
    const { render } = await submitLogin(undefined, '12ab');
    // A form that was sent would start with the fresh XSRF check, and the login would follow its answer.
    for (const request of http.match(AUTH_API.me)) {
      request.flush(null, { status: unauthorized, statusText: 'Error' });
    }
    await render();

    http.expectNone(AUTH_API.login);
  });

  it("sends the form's fields and goes to the return address", async () => {
    const { request } = await logIn('/projects');

    expect(request.method).toBe('POST');
    expect(request.body).toEqual({ userName: 'owner', password: 'secret', totpCode: '123456' });
    expect(url()).toBe('/projects');
    expect(TestBed.inject(AuthService).user()).toEqual({ userName: 'owner' });
  });

  it.each(['/', '/projects', '/projects?open=src%2Fmain.c', '/a/b#c', '/loginx'])(
    'keeps the in-app return address %s',
    async (value) => {
      await logIn(value);

      expect(url()).toBe(value);
    }
  );

  it.each<string | undefined>([
    undefined,
    '',
    'projects',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/login',
    '/login?returnUrl=/x',
    '/login/'
  ])('goes to / instead of the return address %s', async (value) => {
    await logIn(value);

    expect(url()).toBe('/');
  });

  it('clears the password and code after refused credentials and shows a generic error', async () => {
    const { render, root } = await submitAndCheck();
    await answer(AUTH_API.login, unauthorized);
    await render();

    expect(field(root, 'password')).toBe('');
    expect(field(root, 'totpCode')).toBe('');
    expect(field(root, 'userName')).toBe('owner');
    expect(alertText(root)).toContain('Invalid login details.');
    expect(url()).toBe('/login');
  });

  it('shows the wait from Retry-After', async () => {
    const { render, root } = await submitAndCheck();
    const [request] = await pending(AUTH_API.login);
    request.flush(null, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '30' } });
    await render();

    expect(alertText(root)).toContain('Too many attempts. Try again in 30 s.');
  });

  it('reports a login without an answer as no connection', async () => {
    const { render, root } = await submitAndCheck();
    await answer(AUTH_API.login, new ProgressEvent('error'));
    await render();

    expect(alertText(root)).toContain('No connection to the server.');
  });

  it('reports a session that does not work after the login as a server error', async () => {
    const { render, root } = await submitAndCheck();
    await answer(AUTH_API.login, noContent);
    await answer(AUTH_API.me, unauthorized);
    await render();

    expect(alertText(root)).toContain('Server error. Try again.');
  });

  it('warns when the server did not confirm the logout', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, 's1');
    const { render, root } = await open('/login?logout=unconfirmed', { sessionCheck: false });
    const notice = root.querySelector('[role="status"]')!;

    expect(notice.textContent).toContain('the server did not confirm');
    expect(notice.classList).toContain('notice--warning');

    // The screen retries the logout on its own: the answers end that retry, so that no request stays open.
    await answer(AUTH_API.me, me);
    await render();
    await answer(AUTH_API.logout, noContent);
    await render();
  });
});
