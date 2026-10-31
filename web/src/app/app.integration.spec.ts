import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { App } from './app';
import { authGuard, guestGuard } from './core/auth/auth.guards';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AUTH_API, AuthService } from './core/auth/auth.service';
import { HardNavigation } from './core/browser/hard-navigation';
import { Login } from './features/login/login';

/**
 * Integration: the root component with the routes of the app. Real App, router with the guards, AuthService,
 * the interceptor and the login screen. Only HTTP (HttpTestingController) and the page reload are replaced,
 * and the workbench is a stub page, because the real one would start the hubs, the stores and Monaco's loader.
 */

@Component({ template: 'workbench' })
class StubPage {}

describe('App (integration)', () => {
  let http: HttpTestingController;
  let router: Router;
  let fixture: ComponentFixture<App>;

  beforeEach(() => {
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
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(App);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      // Cleanup also after a failed `verify`, so that one error does not break the following tests.
      vi.restoreAllMocks();
      localStorage.clear();
      TestBed.resetTestingModule();
    }
  });

  const me = { userName: 'owner', sessionId: 's1', expiresIn: 1800, absoluteExpiresIn: 43200 };
  const unauthorized = 401;

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
    for (const request of await pending(url)) {
      if (typeof bodyOrStatus === 'number') {
        request.flush(null, { status: bodyOrStatus, statusText: 'Error' });
      } else if (bodyOrStatus instanceof ProgressEvent) {
        request.error(bodyOrStatus);
      } else {
        request.flush(bodyOrStatus);
      }
    }
  }

  async function open(url: string, reply: object | number | ProgressEvent) {
    const navigation = router.navigateByUrl(url);
    await answer(AUTH_API.me, reply);
    await navigation;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const user = () => TestBed.inject(AuthService).user();

  it('renders the login screen in the router outlet when there is no session', async () => {
    const root = await open('/', unauthorized);

    expect(router.parseUrl(router.url).root.children['primary'].segments.map((s) => s.path)).toEqual(['login']);
    expect(root.querySelector('router-outlet')).not.toBeNull();
    expect(root.querySelector('app-login')).not.toBeNull();
    expect(user()).toBeNull();
  });

  it('keeps the requested address as the return address', async () => {
    await open('/?repo=studia%2Flab', unauthorized);

    expect(router.parseUrl(router.url).queryParams['returnUrl']).toBe('/?repo=studia%2Flab');
  });

  it('lets a user with a session in and keeps only the user name', async () => {
    const root = await open('/', { ...me, passwordHash: 'x' });

    expect(router.url).toBe('/');
    expect(root.textContent).toContain('workbench');
    expect(user()).toEqual({ userName: 'owner' });
  });

  it('sends a user with a session from the login screen to the app', async () => {
    const root = await open('/login', me);

    expect(router.url).toBe('/');
    expect(root.textContent).toContain('workbench');
  });

  it('treats an unreachable server as no session', async () => {
    await open('/', new ProgressEvent('error'));

    expect(router.parseUrl(router.url).root.children['primary'].segments.map((s) => s.path)).toEqual(['login']);
    expect(user()).toBeNull();
  });

  it('asks the server once and reuses the answer', async () => {
    const auth = TestBed.inject(AuthService);
    const navigation = router.navigateByUrl('/');
    const direct = auth.ensureSession();

    const requests = await pending(AUTH_API.me);
    // A macrotask lets the guard's own check run before the count, so a second request could not be missed.
    await new Promise((resolve) => setTimeout(resolve));
    requests.push(...http.match(AUTH_API.me));
    expect(requests).toHaveLength(1);
    requests[0].flush(me);

    expect(await direct).toBe(true);
    expect(await navigation).toBe(true);
    expect(await auth.ensureSession()).toBe(true);

    await router.navigateByUrl('/login');
    http.expectNone(AUTH_API.me);
    expect(router.url).toBe('/');
  });
});
