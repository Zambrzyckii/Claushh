import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { FileApiError, FilesApi } from './files-api';

describe('FilesApi', () => {
  let api: FilesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(FilesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists a directory with the path as an encoded query parameter', async () => {
    const result = firstValueFrom(api.list('studia/lab 1'));
    const req = http.expectOne((r) => r.url === '/api/files/list');
    expect(req.request.params.get('path')).toBe('studia/lab 1');
    req.flush([{ name: 'src', path: 'studia/lab 1/src', kind: 'directory', extra: 1 }]);
    expect(await result).toEqual([{ name: 'src', path: 'studia/lab 1/src', kind: 'directory' }]);
  });

  it('reads a file', async () => {
    const result = firstValueFrom(api.read('a/b.c'));
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'a/b.c', content: 'x', version: 'v1' });
    expect(await result).toEqual({ path: 'a/b.c', content: 'x', version: 'v1' });
  });

  it('writes a file with the base version', async () => {
    const result = firstValueFrom(api.write('a/b.c', 'new', 'v1'));
    const req = http.expectOne((r) => r.url === '/api/files/content');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ content: 'new', baseVersion: 'v1' });
    req.flush({ version: 'v2' });
    expect(await result).toEqual({ version: 'v2' });
  });

  it('does not send requests for unsafe paths', async () => {
    await expect(firstValueFrom(api.read('../etc/passwd'))).rejects.toMatchObject({ kind: 'invalid-path' });
    await expect(firstValueFrom(api.list('/'))).rejects.toMatchObject({ kind: 'invalid-path' });
    await expect(firstValueFrom(api.write('a/../../b', '', 'v'))).rejects.toMatchObject({ kind: 'invalid-path' });
    http.expectNone(() => true);
  });

  it('reports a conflict with the current version from the server', async () => {
    const result = firstValueFrom(api.write('a', 'x', 'v1'));
    http
      .expectOne((r) => r.url === '/api/files/content')
      .flush({ currentVersion: 'v9' }, { status: 409, statusText: 'Conflict' });
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileApiError);
    expect(error).toMatchObject({ kind: 'conflict', currentVersion: 'v9' });
  });

  it.each([
    [404, 'not-found'],
    [413, 'too-large'],
    [415, 'binary'],
    [400, 'invalid-path'],
    [500, 'server']
  ])('maps HTTP %i to %s', async (status, kind) => {
    const result = firstValueFrom(api.read('a'));
    http.expectOne((r) => r.url === '/api/files/content').flush(null, { status, statusText: 'x' });
    await expect(result).rejects.toMatchObject({ kind });
  });

  it('maps network errors', async () => {
    const result = firstValueFrom(api.read('a'));
    http.expectOne((r) => r.url === '/api/files/content').error(new ProgressEvent('error'));
    await expect(result).rejects.toMatchObject({ kind: 'network' });
  });
});
