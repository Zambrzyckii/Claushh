import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { vi } from 'vitest';

import { HardNavigation } from '../browser/hard-navigation';
import { authInterceptor } from './auth.interceptor';
import { AUTH_API, AuthService } from './auth.service';

/**
 * Integration: how a session ends. Real AuthService and interceptor behind HttpClient.
 * Only HTTP (HttpTestingController) and the page reload (`HardNavigation`) are replaced.
 * The marker of an unconfirmed logout (`localStorage`) is read by the test under the same key AuthService writes.
 */

/** Marker key from AuthService (`PENDING_LOGOUT_KEY`). */
const PENDING_LOGOUT_KEY = 'claushh-pending-logout';

describe('Session end (integration)', () => {
  let http: HttpTestingController;
  let client: HttpClient;
  let replace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replace = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: HardNavigation, useValue: { replace, currentUrl: () => '/some/path?x=1' } }
      ]
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    // An item in both storages, so that a clearing done by the code under test shows in the counts below.
    sessionStorage.setItem('probe', '1');
    localStorage.setItem('probe', '1');
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      // Cleanup also after a failed `verify`, so that one error does not break the following tests.
      vi.restoreAllMocks();
      sessionStorage.clear();
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

  /** A GET through HttpClient. Resolves to the error the caller receives, or to null when the request succeeded. */
  function send(url: string): Promise<unknown> {
    return firstValueFrom(client.get(url)).then(
      () => null,
      (error: unknown) => error
    );
  }

  /** Sends a GET, answers it and waits until the caller has its result. */
  async function get(url: string, status: number): Promise<unknown> {
    const outcome = send(url);
    await answer(url, status);
    return outcome;
  }

  it('a 401 from an API request reloads to /login with the current address', async () => {
    await get('/api/files?path=src', unauthorized);

    expect(replace).toHaveBeenCalledExactlyOnceWith('/login?reason=expired&returnUrl=%2Fsome%2Fpath%3Fx%3D1');
    expect(sessionStorage.length).toBe(0);
  });

  it('requests failing at the same time reload only once', async () => {
    const outcomes = [send('/api/files'), send('/api/files'), send('/api/files')];
    const requests = await answer('/api/files', unauthorized);
    await Promise.all(outcomes);

    expect(requests).toHaveLength(3);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each([AUTH_API.me, AUTH_API.login, AUTH_API.logout, `${AUTH_API.me}?x=1`])(
    'a 401 from its own endpoint %s does not end the session',
    async (url) => {
      await get(url, unauthorized);

      expect(replace).not.toHaveBeenCalled();
    }
  );

  it('other error codes do not end the session', async () => {
    await get('/api/files', 403);
    expect(replace).not.toHaveBeenCalled();

    await get('/api/files', 500);
    expect(replace).not.toHaveBeenCalled();
  });

  it('a 401 from outside /api does not end the session', async () => {
    await get('/apistuff', unauthorized);
    expect(replace).not.toHaveBeenCalled();

    await get('https://example.com/api/x', unauthorized);
    expect(replace).not.toHaveBeenCalled();
  });

  it('the caller still receives the 401', async () => {
    const error = await get('/api/files', unauthorized);

    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error).toMatchObject({ status: 401 });
  });

  it('logging out ends the server session, clears the storage and reloads to /login?logout=ok', async () => {
    const auth = TestBed.inject(AuthService);
    const check = auth.ensureSession();
    await answer(AUTH_API.me, me);
    await check;
    expect(auth.user()).toEqual({ userName: 'owner' });

    const done = auth.logout();
    const [request] = await answer(AUTH_API.logout, noContent);
    await done;

    expect(request.request.method).toBe('POST');
    expect(auth.user()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(replace).toHaveBeenCalledExactlyOnceWith('/login?logout=ok');
  });

  it('a 401 to the logout counts as an ended session', async () => {
    const done = TestBed.inject(AuthService).logout();
    await answer(AUTH_API.logout, unauthorized);
    await done;

    expect(replace).toHaveBeenCalledExactlyOnceWith('/login?logout=ok');
  });

  it('a logout without an answer keeps only the marker', async () => {
    const done = TestBed.inject(AuthService).logout();
    await answer(AUTH_API.logout, new ProgressEvent('error'));
    await done;

    expect(sessionStorage.length).toBe(0);
    expect(Object.keys(localStorage)).toEqual([PENDING_LOGOUT_KEY]);
    expect(replace).toHaveBeenCalledExactlyOnceWith('/login?logout=unconfirmed');
  });
});
