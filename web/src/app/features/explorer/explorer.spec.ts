import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';

import { DirectoryEntry, FileApiError, FilesApi } from '../../core/api/files-api';
import { Explorer } from './explorer';

describe('Explorer', () => {
  const tree: Record<string, DirectoryEntry[]> = {
    '': [
      { name: 'README.md', path: 'README.md', kind: 'file' },
      { name: 'src', path: 'src', kind: 'directory' },
      { name: 'file10.c', path: 'file10.c', kind: 'file' },
      { name: 'file2.c', path: 'file2.c', kind: 'file' }
    ],
    src: [{ name: 'main.c', path: 'src/main.c', kind: 'file' }]
  };
  let list: ReturnType<typeof vi.fn>;

  async function create() {
    TestBed.configureTestingModule({ imports: [Explorer], providers: [{ provide: FilesApi, useValue: { list } }] });
    const fixture = TestBed.createComponent(Explorer);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const labels = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('.row__name, .status')).map((e) => e.textContent!.trim());

  beforeEach(() => {
    list = vi.fn((path: string) => of(tree[path] ?? []));
  });

  it('shows directories first and sorts names naturally', async () => {
    const fixture = await create();
    expect(labels(fixture.nativeElement)).toEqual(['src', 'file2.c', 'file10.c', 'README.md']);
  });

  it('loads a directory only when it is expanded, and collapses it again', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    expect(list).toHaveBeenCalledTimes(1);

    const dir = root.querySelector<HTMLButtonElement>('.row')!;
    expect(dir.getAttribute('aria-expanded')).toBe('false');
    dir.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(list).toHaveBeenLastCalledWith('src');
    expect(labels(root)).toEqual(['src', 'main.c', 'file2.c', 'file10.c', 'README.md']);

    root.querySelector<HTMLButtonElement>('.row')!.click();
    fixture.detectChanges();
    expect(labels(root)).toEqual(['src', 'file2.c', 'file10.c', 'README.md']);
  });

  it('emits the path of a clicked file', async () => {
    const fixture = await create();
    const opened: string[] = [];
    fixture.componentInstance.openFile.subscribe((p) => opened.push(p));
    const readme = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.row')).find(
      (b) => b.textContent!.includes('README.md')
    )!;
    readme.click();
    expect(opened).toEqual(['README.md']);
  });

  it('shows loading and error states', async () => {
    const pending = new Subject<DirectoryEntry[]>();
    list = vi.fn(() => pending);
    const fixture = await create();
    expect(labels(fixture.nativeElement)).toEqual(['Wczytywanie…']);

    pending.error(new FileApiError('network'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(labels(fixture.nativeElement)).toEqual(['Brak połączenia z serwerem.']);
  });

  it('reloads the root and expanded directories on refresh', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('.row')!.click();
    await fixture.whenStable();
    list.mockClear();
    list.mockImplementation((path: string) => (path === 'src' ? throwError(() => new FileApiError('not-found')) : of(tree[path])));

    root.querySelector<HTMLButtonElement>('.header__refresh')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(list.mock.calls.map((c) => c[0])).toEqual(['', 'src']);
    expect(labels(root)).toContain('Plik nie istnieje.');
  });
});
