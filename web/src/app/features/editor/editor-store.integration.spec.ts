import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ProjectContext } from '../../core/project/project-context';
import { EditorStore } from './editor-store';

/**
 * Integration: the real EditorStore with the real FilesApi, GitApi and ProjectContext (router). Only HTTP is replaced
 * (HttpTestingController). Reads are `GET /api/files/content` and writes are `PUT /api/files/content`, both with the
 * file's path as the `path` parameter.
 */
describe('Editor store (integration)', () => {
  const CONTENT_URL = '/api/files/content';
  let http: HttpTestingController;
  let store: EditorStore;

  const tick = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), ProjectContext, EditorStore]
    });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(EditorStore);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      // Cleanup also after a failed `verify`, so that one error does not break the following tests.
      TestBed.resetTestingModule();
    }
  });

  /** Takes the one pending request of the method for the path, and fails when there is none or more than one. */
  const contentRequest = (method: 'GET' | 'PUT', path: string) =>
    http.expectOne((r) => r.url === CONTENT_URL && r.method === method && r.params.get('path') === path);

  /** Answers the pending read of the path with the file. */
  function respond(path: string, content: string, version: string) {
    contentRequest('GET', path).flush({ path, content, version });
  }

  /** Answers a request with an error status and, when given, an error body. */
  function fail(request: TestRequest, status: number, body: object | null = null) {
    request.flush(body, { status, statusText: 'Error' });
  }

  /** Answers a request as a network failure: no answer arrived. */
  function noAnswer(request: TestRequest) {
    request.error(new ProgressEvent('error'));
  }

  async function openReady(path: string, content = 'hello', version = 'v1') {
    const done = store.open(path);
    respond(path, content, version);
    await done;
  }

  it('opens a file as the active document', async () => {
    const done = store.open('src/main.c');
    expect(store.active()).toMatchObject({ path: 'src/main.c', name: 'main.c', status: 'loading' });
    const request = http.expectOne((r) => r.url === CONTENT_URL);
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('path')).toBe('src/main.c');
    request.flush({ path: 'src/main.c', content: 'int main() {}', version: 'v1' });
    await done;
    expect(store.active()).toMatchObject({ status: 'ready', value: 'int main() {}', version: 'v1' });
  });

  it('only activates a file that is already open', async () => {
    await openReady('a');
    await openReady('b');
    await store.open('a');
    http.expectNone((r) => r.url === CONTENT_URL);
    expect(store.activePath()).toBe('a');
    expect(store.documents().map((d) => d.path)).toEqual(['a', 'b']);
  });

  it('shows an error for files that cannot be opened and allows retrying', async () => {
    const done = store.open('bin');
    fail(contentRequest('GET', 'bin'), 415);
    await done;
    expect(store.active()).toMatchObject({ status: 'error', error: 'This is a binary file and cannot be shown as text.' });

    const retry = store.open('bin');
    respond('bin', 'ok', 'v1');
    await retry;
    expect(store.active()).toMatchObject({ status: 'ready', value: 'ok' });
    expect(store.documents()).toHaveLength(1);
  });

  it('tracks unsaved changes', async () => {
    await openReady('a');
    store.updateValue('a', 'changed');
    expect(store.isDirty('a')).toBe(true);
    expect(store.unsavedCount()).toBe(1);
    store.updateValue('a', 'hello');
    expect(store.isDirty('a')).toBe(false);
  });

  it('saves with the version the edit was based on', async () => {
    await openReady('a');
    store.updateValue('a', 'changed');
    const saving = store.save();
    const request = http.expectOne((r) => r.url === CONTENT_URL);
    expect(request.request.method).toBe('PUT');
    expect(request.request.params.get('path')).toBe('a');
    expect(request.request.body).toEqual({ content: 'changed', baseVersion: 'v1' });
    expect(store.active()?.saving).toBe(true);
    request.flush({ version: 'v2' });
    await saving;
    expect(store.active()).toMatchObject({ saving: false, version: 'v2', savedValue: 'changed' });
    expect(store.isDirty('a')).toBe(false);
  });

  it('keeps edits typed during a save as unsaved', async () => {
    await openReady('a');
    store.updateValue('a', 'first');
    const saving = store.save();
    store.updateValue('a', 'second');
    contentRequest('PUT', 'a').flush({ version: 'v2' });
    await saving;
    expect(store.active()).toMatchObject({ savedValue: 'first', value: 'second' });
    expect(store.isDirty('a')).toBe(true);
  });

  it('does not save unchanged files or send a second save while one is running', async () => {
    await openReady('a');
    await store.save();
    http.expectNone((r) => r.url === CONTENT_URL);
    store.updateValue('a', 'x');
    const first = store.save();
    void store.save();
    contentRequest('PUT', 'a').flush({ version: 'v2' });
    await first;
  });

  it('reports a conflict instead of overwriting changes made on disk', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    fail(contentRequest('PUT', 'a'), 409, { currentVersion: 'v5' });
    await saving;
    expect(store.active()).toMatchObject({ conflict: { currentVersion: 'v5' }, value: 'mine', savedValue: 'hello' });

    await store.save();
    http.expectNone((r) => r.url === CONTENT_URL);
  });

  it('overwrites after a conflict using the version currently on disk', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    fail(contentRequest('PUT', 'a'), 409, { currentVersion: 'v5' });
    await saving;

    const overwriting = store.overwrite('a');
    const request = contentRequest('PUT', 'a');
    expect(request.request.body).toEqual({ content: 'mine', baseVersion: 'v5' });
    request.flush({ version: 'v6' });
    await overwriting;
    expect(store.active()).toMatchObject({ conflict: null, version: 'v6', savedValue: 'mine' });
  });

  it('reloads from disk after a conflict and bumps the revision for the editor', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    fail(contentRequest('PUT', 'a'), 409, { currentVersion: 'v5' });
    await saving;
    const revision = store.active()!.revision;

    const reloading = store.reload('a');
    respond('a', 'theirs', 'v5');
    await reloading;
    expect(store.active()).toMatchObject({
      conflict: null,
      value: 'theirs',
      savedValue: 'theirs',
      version: 'v5',
      revision: revision + 1
    });
  });

  it('keeps the text and shows an error when saving fails', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    noAnswer(contentRequest('PUT', 'a'));
    await saving;
    expect(store.active()).toMatchObject({ value: 'mine', saving: false, error: 'Not saved. No connection to the server.' });
    expect(store.isDirty('a')).toBe(true);
  });

  it('refuses to close a file with unsaved changes unless forced', async () => {
    await openReady('a');
    store.updateValue('a', 'x');
    expect(store.close('a')).toBe(false);
    expect(store.documents()).toHaveLength(1);
    expect(store.close('a', true)).toBe(true);
    expect(store.documents()).toHaveLength(0);
    expect(store.activePath()).toBeNull();
  });

  it('activates the neighbouring tab after closing the active one', async () => {
    await openReady('a');
    await openReady('b');
    await openReady('c');
    store.activate('b');
    store.close('b');
    expect(store.activePath()).toBe('c');
    store.close('c');
    expect(store.activePath()).toBe('a');
  });

  it('ignores a late response for a file closed in the meantime', async () => {
    const done = store.open('a');
    store.close('a');
    respond('a', 'x', 'v1');
    await done;
    await tick();
    expect(store.documents()).toHaveLength(0);
  });

  it.each([
    [404, 'The file does not exist.'],
    [413, 'The file is too large to open in the editor.'],
    [415, 'This is a binary file and cannot be shown as text.'],
    [400, 'Invalid path.'],
    [500, 'Server error.']
  ])('shows the message for HTTP %i when opening', async (status, message) => {
    const done = store.open('a');
    fail(contentRequest('GET', 'a'), status);
    await done;
    expect(store.active()?.error).toBe(message);
  });

  it('shows no connection when opening gets no answer', async () => {
    const done = store.open('a');
    noAnswer(contentRequest('GET', 'a'));
    await done;
    expect(store.active()?.error).toBe('No connection to the server.');
  });

  it('sends nothing when opening an unsafe path', async () => {
    await store.open('../etc/passwd');
    http.expectNone((r) => r.url === CONTENT_URL);
    expect(store.active()?.error).toBe('Invalid path.');
  });

  it('names a document by the last segment of its path', async () => {
    await openReady('src/main.c');
    await openReady('main.c');
    expect(store.documents().map((d) => d.name)).toEqual(['main.c', 'main.c']);
  });
});
