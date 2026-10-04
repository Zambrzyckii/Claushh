import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { vi } from 'vitest';

import { authGuard, guestGuard } from '../../core/auth/auth.guards';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { AUTH_API } from '../../core/auth/auth.service';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { Login } from './login';

/**
 * Integration: the login screen after a 429. Real routes with guards, AuthService, interceptor and the login component;
 * only HTTP (HttpTestingController) and the clock are replaced. The wait from Retry-After reads in seconds, minutes or hours.
 */

@Component({ template: 'aplikacja' })
class App {}

describe('Login wait after 429 (integration)', () => {
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
      vi.useRealTimers();
      TestBed.resetTestingModule();
    }
  });

  it.each([
    ['30', 'Zbyt wiele prób. Spróbuj ponownie za 30 s.'],
    ['900', 'Zbyt wiele prób. Spróbuj ponownie za 15 min.'],
    ['86400', 'Zbyt wiele prób. Spróbuj ponownie za 24 godz.']
  ])('Retry-After %s reads "%s"', async (retryAfter, text) => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' }); // guestGuard: no session
    await navigation;
    const root = harness.routeNativeElement as HTMLElement;

    fill(root, 'userName', 'owner');
    fill(root, 'password', 'secret');
    fill(root, 'totpCode', '123456');
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' }); // a fresh XSRF token first
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(AUTH_API.login).flush(null, {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Retry-After': retryAfter }
    });
    await vi.advanceTimersByTimeAsync(0);
    harness.detectChanges();

    expect(root.querySelector('[role="alert"]')!.textContent!.trim()).toBe(text);
  });
});

function fill(root: HTMLElement, id: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
