import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { HardNavigation } from '../browser/hard-navigation';
import { AUTH_API, AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;
  let navigation: { replace: ReturnType<typeof vi.fn>; currentUrl: ReturnType<typeof vi.fn> };

  const credentials = { userName: 'owner', password: 'secret', totpCode: '123456' };

  /** Waits until promises from firstValueFrom manage to send further requests. */
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    navigation = { replace: vi.fn(), currentUrl: vi.fn(() => '/some/path?x=1') };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: HardNavigation, useValue: navigation }
      ]
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    sessionStorage.setItem('probe', '1');
    localStorage.setItem('probe', '1');
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
    localStorage.clear();
  });

  describe('ensureSession', () => {
    it('returns true and exposes the user when the server confirms the session', async () => {
      const result = service.ensureSession();
      http.expectOne(AUTH_API.me).flush({ userName: 'owner' });
      expect(await result).toBe(true);
      expect(service.user()).toEqual({ userName: 'owner' });
    });

    it('returns false on 401', async () => {
      const result = service.ensureSession();
      http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
      expect(await result).toBe(false);
      expect(service.user()).toBeNull();
    });

    it('fails closed when the server is unreachable', async () => {
      const result = service.ensureSession();
      http.expectOne(AUTH_API.me).error(new ProgressEvent('error'));
      expect(await result).toBe(false);
    });

    it('sends a single request for concurrent checks and caches the result', async () => {
      const first = service.ensureSession();
      const second = service.ensureSession();
      http.expectOne(AUTH_API.me).flush({ userName: 'owner' });
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(await service.ensureSession()).toBe(true);
      http.expectNone(AUTH_API.me);
    });

    it('keeps only the expected fields from the server response', async () => {
      const result = service.ensureSession();
      http.expectOne(AUTH_API.me).flush({ userName: 'owner', passwordHash: 'x' });
      await result;
      expect(service.user()).toEqual({ userName: 'owner' });
    });
  });

  describe('login', () => {
    it('posts credentials and re-checks the session', async () => {
      const result = service.login(credentials);
      const req = http.expectOne(AUTH_API.login);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(credentials);
      req.flush(null, { status: 204, statusText: 'No Content' });
      await flushMicrotasks();
      http.expectOne(AUTH_API.me).flush({ userName: 'owner' });
      expect(await result).toEqual({ ok: true });
      expect(service.user()).toEqual({ userName: 'owner' });
    });

    it('reports invalid credentials on 401 without revealing details', async () => {
      const result = service.login(credentials);
      http.expectOne(AUTH_API.login).flush(null, { status: 401, statusText: 'Unauthorized' });
      expect(await result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('reports rate limiting with Retry-After', async () => {
      const result = service.login(credentials);
      http
        .expectOne(AUTH_API.login)
        .flush(null, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '30' } });
      expect(await result).toEqual({ ok: false, reason: 'rate-limited', retryAfterSeconds: 30 });
    });

    it('reports network errors', async () => {
      const result = service.login(credentials);
      http.expectOne(AUTH_API.login).error(new ProgressEvent('error'));
      expect(await result).toEqual({ ok: false, reason: 'network' });
    });

    it('fails when the session cookie does not work after login', async () => {
      const result = service.login(credentials);
      http.expectOne(AUTH_API.login).flush(null, { status: 204, statusText: 'No Content' });
      await flushMicrotasks();
      http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
      expect(await result).toEqual({ ok: false, reason: 'server' });
    });
  });

  describe('logout', () => {
    it('invalidates the server session, clears storage and reloads to /login', async () => {
      const login = service.ensureSession();
      http.expectOne(AUTH_API.me).flush({ userName: 'owner' });
      await login;

      const done = service.logout();
      const req = http.expectOne(AUTH_API.logout);
      expect(req.request.method).toBe('POST');
      req.flush(null, { status: 204, statusText: 'No Content' });
      await done;

      expect(service.user()).toBeNull();
      expect(sessionStorage.length).toBe(0);
      expect(localStorage.length).toBe(0);
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/login?logout=ok');
    });

    it('treats 401 as an already finished session', async () => {
      const done = service.logout();
      http.expectOne(AUTH_API.logout).flush(null, { status: 401, statusText: 'Unauthorized' });
      await done;
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/login?logout=ok');
    });

    it('still clears local state when the server does not confirm', async () => {
      const done = service.logout();
      http.expectOne(AUTH_API.logout).error(new ProgressEvent('error'));
      await done;
      expect(sessionStorage.length).toBe(0);
      expect(localStorage.length).toBe(0);
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith('/login?logout=unconfirmed');
    });
  });

  describe('handleSessionExpired', () => {
    it('clears state and reloads to /login with the current address', () => {
      service.handleSessionExpired();
      expect(sessionStorage.length).toBe(0);
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(
        '/login?reason=expired&returnUrl=%2Fsome%2Fpath%3Fx%3D1'
      );
    });

    it('navigates only once when many requests fail at the same time', () => {
      service.handleSessionExpired();
      service.handleSessionExpired();
      service.handleSessionExpired();
      expect(navigation.replace).toHaveBeenCalledTimes(1);
    });
  });
});
