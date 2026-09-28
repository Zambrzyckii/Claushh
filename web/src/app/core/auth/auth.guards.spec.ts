import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { authGuard, guestGuard } from './auth.guards';
import { AuthService } from './auth.service';

describe('auth guards', () => {
  let ensureSession: ReturnType<typeof vi.fn>;
  const route = {} as ActivatedRouteSnapshot;
  const state = { url: '/projects?open=1' } as RouterStateSnapshot;

  beforeEach(() => {
    ensureSession = vi.fn();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { ensureSession } }]
    });
  });

  const run = (guard: typeof authGuard) => TestBed.runInInjectionContext(() => guard(route, state));
  const serialize = (tree: unknown) => TestBed.inject(Router).serializeUrl(tree as UrlTree);

  it('authGuard lets an authenticated user in', async () => {
    ensureSession.mockResolvedValue(true);
    expect(await run(authGuard)).toBe(true);
  });

  it('authGuard sends an anonymous user to /login with the return address', async () => {
    ensureSession.mockResolvedValue(false);
    expect(serialize(await run(authGuard))).toBe('/login?returnUrl=%2Fprojects%3Fopen%3D1');
  });

  it('guestGuard shows the login page to an anonymous user', async () => {
    ensureSession.mockResolvedValue(false);
    expect(await run(guestGuard)).toBe(true);
  });

  it('guestGuard sends an authenticated user to the app', async () => {
    ensureSession.mockResolvedValue(true);
    expect(serialize(await run(guestGuard))).toBe('/');
  });
});
