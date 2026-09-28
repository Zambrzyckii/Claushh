import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { vi } from 'vitest';

import { authInterceptor } from './auth.interceptor';
import { AUTH_API, AuthService } from './auth.service';

describe('authInterceptor', () => {
  let client: HttpClient;
  let http: HttpTestingController;
  let auth: { handleSessionExpired: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auth = { handleSessionExpired: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth }
      ]
    });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function respond(url: string, status: number): Promise<void> {
    const request = firstValueFrom(client.get(url)).catch(() => undefined);
    http.expectOne(url).flush(null, { status, statusText: 'x' });
    await request;
  }

  it('ends the session on 401 from a regular API endpoint', async () => {
    await respond('/api/files?path=src', 401);
    expect(auth.handleSessionExpired).toHaveBeenCalledTimes(1);
  });

  it.each([AUTH_API.me, AUTH_API.login, AUTH_API.logout, `${AUTH_API.me}?x=1`])(
    'ignores 401 from its own auth endpoint %s',
    async (url) => {
      await respond(url, 401);
      expect(auth.handleSessionExpired).not.toHaveBeenCalled();
    }
  );

  it('ignores other error codes', async () => {
    await respond('/api/files', 403);
    await respond('/api/files', 500);
    expect(auth.handleSessionExpired).not.toHaveBeenCalled();
  });

  it('ignores requests outside /api', async () => {
    await respond('/apistuff', 401);
    await respond('https://example.com/api/x', 401);
    expect(auth.handleSessionExpired).not.toHaveBeenCalled();
  });

  it('passes the error on to the caller', async () => {
    const request = firstValueFrom(client.get('/api/files'));
    http.expectOne('/api/files').flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(request).rejects.toMatchObject({ status: 401 });
  });
});
