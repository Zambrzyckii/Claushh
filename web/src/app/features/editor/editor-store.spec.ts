import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';

import { FileApiError, FileContent, FilesApi } from '../../core/api/files-api';
import { EditorStore } from './editor-store';

describe('EditorStore', () => {
  let store: EditorStore;
  let reads: Map<string, Subject<FileContent>>;
  let writes: Subject<{ version: string }>[];
  let files: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };

  const tick = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    reads = new Map();
    writes = [];
    files = {
      read: vi.fn((path: string) => {
        const subject = new Subject<FileContent>();
        reads.set(path, subject);
        return subject;
      }),
      write: vi.fn(() => {
        const subject = new Subject<{ version: string }>();
        writes.push(subject);
        return subject;
      })
    };
    TestBed.configureTestingModule({ providers: [EditorStore, { provide: FilesApi, useValue: files }] });
    store = TestBed.inject(EditorStore);
  });

  function respond(path: string, content: string, version: string) {
    const subject = reads.get(path)!;
    subject.next({ path, content, version });
    subject.complete();
  }

  function fail<T>(subject: Subject<T>, error: unknown) {
    subject.error(error);
  }

  async function openReady(path: string, content = 'hello', version = 'v1') {
    const done = store.open(path);
    respond(path, content, version);
    await done;
  }

  it('opens a file as the active document', async () => {
    const done = store.open('src/main.c');
    expect(store.active()).toMatchObject({ path: 'src/main.c', name: 'main.c', status: 'loading' });
    respond('src/main.c', 'int main() {}', 'v1');
    await done;
    expect(store.active()).toMatchObject({ status: 'ready', value: 'int main() {}', version: 'v1' });
  });

  it('only activates a file that is already open', async () => {
    await openReady('a');
    await openReady('b');
    await store.open('a');
    expect(files.read).toHaveBeenCalledTimes(2);
    expect(store.activePath()).toBe('a');
    expect(store.documents().map((d) => d.path)).toEqual(['a', 'b']);
  });

  it('shows an error for files that cannot be opened and allows retrying', async () => {
    const done = store.open('bin');
    fail(reads.get('bin')!, new FileApiError('binary'));
    await done;
    expect(store.active()).toMatchObject({ status: 'error', error: 'To plik binarny, nie da się go wyświetlić jako tekst.' });

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
    expect(files.write).toHaveBeenCalledWith('a', 'changed', 'v1');
    expect(store.active()?.saving).toBe(true);
    writes[0].next({ version: 'v2' });
    writes[0].complete();
    await saving;
    expect(store.active()).toMatchObject({ saving: false, version: 'v2', savedValue: 'changed' });
    expect(store.isDirty('a')).toBe(false);
  });

  it('keeps edits typed during a save as unsaved', async () => {
    await openReady('a');
    store.updateValue('a', 'first');
    const saving = store.save();
    store.updateValue('a', 'second');
    writes[0].next({ version: 'v2' });
    writes[0].complete();
    await saving;
    expect(store.active()).toMatchObject({ savedValue: 'first', value: 'second' });
    expect(store.isDirty('a')).toBe(true);
  });

  it('does not save unchanged files or send a second save while one is running', async () => {
    await openReady('a');
    await store.save();
    expect(files.write).not.toHaveBeenCalled();
    store.updateValue('a', 'x');
    void store.save();
    void store.save();
    expect(files.write).toHaveBeenCalledTimes(1);
  });

  it('reports a conflict instead of overwriting changes made on disk', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    fail(writes[0], new FileApiError('conflict', 'v5'));
    await saving;
    expect(store.active()).toMatchObject({ conflict: { currentVersion: 'v5' }, value: 'mine', savedValue: 'hello' });

    await store.save();
    expect(files.write).toHaveBeenCalledTimes(1);
  });

  it('overwrites after a conflict using the version currently on disk', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    fail(writes[0], new FileApiError('conflict', 'v5'));
    await saving;

    const overwriting = store.overwrite('a');
    expect(files.write).toHaveBeenLastCalledWith('a', 'mine', 'v5');
    writes[1].next({ version: 'v6' });
    writes[1].complete();
    await overwriting;
    expect(store.active()).toMatchObject({ conflict: null, version: 'v6', savedValue: 'mine' });
  });

  it('reloads from disk after a conflict and bumps the revision for the editor', async () => {
    await openReady('a');
    store.updateValue('a', 'mine');
    const saving = store.save();
    fail(writes[0], new FileApiError('conflict', 'v5'));
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
    fail(writes[0], new FileApiError('network'));
    await saving;
    expect(store.active()).toMatchObject({ value: 'mine', saving: false, error: 'Nie zapisano. Brak połączenia z serwerem.' });
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
});
