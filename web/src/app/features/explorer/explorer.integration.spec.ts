import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { DirectoryEntry } from '../../core/api/files-api';
import { ProjectContext } from '../../core/project/project-context';
import { Explorer } from './explorer';

/**
 * Integration: the real Explorer with the real FilesApi and ProjectContext (router). Only HTTP is replaced
 * (HttpTestingController). The host holds the tree root and collects the paths of the files the Explorer opens.
 */
@Component({
  imports: [Explorer],
  providers: [ProjectContext],
  template: '<app-explorer [root]="root()" (openFile)="opened.push($event)" />'
})
class Host {
  readonly root = signal('');
  readonly opened: string[] = [];
}

describe('Explorer (integration)', () => {
  const LIST_URL = '/api/files/list';
  const rootEntries: DirectoryEntry[] = [
    { name: 'README.md', path: 'README.md', kind: 'file' },
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'file10.c', path: 'file10.c', kind: 'file' },
    { name: 'file2.c', path: 'file2.c', kind: 'file' }
  ];
  const srcEntries: DirectoryEntry[] = [{ name: 'main.c', path: 'src/main.c', kind: 'file' }];
  let http: HttpTestingController;

  /** Creates the host with the given tree root. When the root is a safe path, its listing request is left pending for the test. */
  async function setup(root = '') {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.root.set(root);
    const element = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
        fixture.detectChanges();
      }
    };
    await settle();
    return { element, settle, host: fixture.componentInstance };
  }

  afterEach(() => {
    try {
      http.verify();
    } finally {
      // Cleanup also after a failed `verify`, so that one error does not break the following tests.
      TestBed.resetTestingModule();
    }
  });

  /** Takes the one pending listing request. It fails when there is none or more than one. */
  const listRequest = () => http.expectOne((r) => r.url === LIST_URL);

  /** Takes the one pending listing request of the directory, and fails when there is none or more than one. */
  const listRequestFor = (path: string) => http.expectOne((r) => r.url === LIST_URL && r.params.get('path') === path);

  const labels = (element: HTMLElement) =>
    Array.from(element.querySelectorAll('.row__name, .status')).map((e) => e.textContent!.trim());

  const row = (element: HTMLElement, name: string) =>
    Array.from(element.querySelectorAll<HTMLButtonElement>('.row')).find(
      (button) => button.querySelector('.row__name')!.textContent!.trim() === name
    )!;

  it('shows directories first and sorts names naturally', async () => {
    const { element, settle } = await setup();
    listRequest().flush(rootEntries);
    await settle();

    expect(labels(element)).toEqual(['src', 'file2.c', 'file10.c', 'README.md']);
  });

  it('asks for a directory with its path as a query parameter', async () => {
    const { element, settle } = await setup('studia/lab 1');
    const request = listRequest();
    request.flush([{ name: 'src', path: 'studia/lab 1/src', kind: 'directory', extra: 1 }]);
    await settle();

    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('path')).toBe('studia/lab 1');
    expect(labels(element)).toEqual(['src']);
  });

  it('loads a directory only when it is expanded, and collapses it again', async () => {
    const { element, settle } = await setup();
    listRequestFor('').flush(rootEntries);
    await settle();
    expect(row(element, 'src').getAttribute('aria-expanded')).toBe('false');
    http.expectNone((r) => r.url === LIST_URL);

    row(element, 'src').click();
    await settle();
    expect(row(element, 'src').getAttribute('aria-expanded')).toBe('true');
    listRequestFor('src').flush(srcEntries);
    await settle();
    expect(labels(element)).toEqual(['src', 'main.c', 'file2.c', 'file10.c', 'README.md']);

    row(element, 'src').click();
    await settle();
    http.expectNone((r) => r.url === LIST_URL);
    expect(row(element, 'src').getAttribute('aria-expanded')).toBe('false');
    expect(labels(element)).toEqual(['src', 'file2.c', 'file10.c', 'README.md']);
  });

  it('emits the path of a clicked file', async () => {
    const { element, settle, host } = await setup();
    listRequest().flush(rootEntries);
    await settle();
    expect(host.opened).toEqual([]);

    row(element, 'README.md').click();
    await settle();

    expect(host.opened).toEqual(['README.md']);
    http.expectNone((r) => r.url === LIST_URL);
  });

  it('shows loading and then no connection', async () => {
    const { element, settle } = await setup();
    const request = listRequest();
    expect(labels(element)).toEqual(['Loading…']);

    request.error(new ProgressEvent('error'));
    await settle();

    expect(labels(element)).toEqual(['No connection to the server.']);
  });

  it('reloads the root and the expanded directories on refresh', async () => {
    const { element, settle } = await setup();
    listRequestFor('').flush(rootEntries);
    await settle();
    row(element, 'src').click();
    await settle();
    listRequestFor('src').flush(srcEntries);
    await settle();
    expect(labels(element)).toContain('main.c');

    element.querySelector<HTMLButtonElement>('.header__refresh')!.click();
    await settle();
    const requests: TestRequest[] = http.match((r) => r.url === LIST_URL);
    expect(requests.map((r) => r.request.params.get('path'))).toEqual(['', 'src']);
    requests[0].flush(rootEntries);
    requests[1].flush(null, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(labels(element)).toContain('The file does not exist.');
    expect(labels(element)).not.toContain('main.c');
  });

  it.each(['', 'a', 'studia/lab/src/main.c', '.gitignore', 'a/.hidden/b', 'a..b/c'])(
    'asks the server for the safe path %s',
    async (path) => {
      const { settle } = await setup(path);
      const request = listRequest();
      request.flush([]);
      await settle();

      expect(request.request.params.get('path')).toBe(path);
    }
  );

  it.each(['/etc/passwd', '..', '../x', 'a/../../x', 'a/./b', 'a//b', 'a/', 'a\\b', '..\\x', 'a\0b'])(
    'sends nothing for the unsafe path %s',
    async (path) => {
      const { element, settle } = await setup(path);
      await settle();

      http.expectNone((r) => r.url === LIST_URL);
      expect(labels(element)).toEqual(['Invalid path.']);
    }
  );
});
