import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { SearchResult } from '../../core/api/search-api';
import { ProjectContext } from '../../core/project/project-context';
import { EditorStore } from '../editor/editor-store';
import { WorkbenchState } from '../workspace/workbench-state';
import { SearchStore } from './search-store';
import { SearchView } from './search-view';

/**
 * Integration: the real SearchView with SearchStore, SearchApi, EditorStore, WorkbenchState and ProjectContext (router),
 * on fake timers. Only HTTP is replaced (HttpTestingController).
 */
@Component({
  imports: [SearchView],
  providers: [ProjectContext, EditorStore, WorkbenchState, SearchStore],
  template: '<app-search-view />'
})
class Host {
  readonly editor = inject(EditorStore);
  readonly state = inject(WorkbenchState);
}

const RESULT: SearchResult = {
  files: [
    {
      path: 'studia/lab/src/main.c',
      matches: [
        { line: 3, column: 5, preview: 'int main(void)', ranges: [[4, 8]] },
        { line: 7, column: 12, preview: 'return main_loop(main);', ranges: [[7, 11], [17, 21]] }
      ]
    },
    { path: 'studia/lab/Makefile', matches: [{ line: 2, column: 16, preview: 'cc -o app src/main.c', ranges: [[14, 18]] }] }
  ],
  matchCount: 4,
  limit: null
};

describe('Search (integration)', () => {
  let http: HttpTestingController;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    const render = async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
    };
    await render();
    return { root, render, host: fixture.componentInstance };
  }

  const field = (root: HTMLElement) => root.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
  const texts = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)).map((e) => e.textContent!.trim());
  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  const enter = (input: HTMLInputElement) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

  it('searches 300 ms after the last keystroke, drops the older request, and Enter searches at once', async () => {
    const { root, render } = await setup();
    type(field(root), 'mai');
    await render(200);
    type(field(root), 'main');
    await render(299);
    http.expectNone('/api/search');
    await render(1);
    const first = http.expectOne('/api/search');
    expect(first.request.method).toBe('POST');
    expect(first.request.body).toEqual({ path: '', query: 'main', matchCase: false, wholeWord: false, regex: false, include: '', exclude: '' });
    expect(texts(root, '.message')).toEqual(['Searching…']);

    type(field(root), 'main(');
    enter(field(root));
    await render();
    expect(first.cancelled).toBe(true);
    const second = http.expectOne('/api/search');
    expect(second.request.body.query).toBe('main(');
    second.flush(RESULT);
    await render();
    expect(texts(root, '.message')).toEqual(['4 results in 2 files']);
  });

  it('groups the matches by file with counts, highlights them as text, and a click opens the file at the match', async () => {
    const { root, render, host } = await setup();
    type(field(root), 'main');
    enter(field(root));
    await render();
    http.expectOne('/api/search').flush(RESULT);
    await render();

    expect(texts(root, '.search-file__name')).toEqual(['main.c', 'Makefile']);
    expect(texts(root, '.search-file__dir')).toEqual(['studia/lab/src', 'studia/lab']);
    expect(texts(root, '.search-file .badge')).toEqual(['3', '1']);
    expect(Array.from(root.querySelectorAll('.search-file img.file-icon')).map((icon) => icon.getAttribute('src'))).toEqual([
      'file-icons/c.svg',
      'file-icons/makefile.svg'
    ]);
    const match = root.querySelectorAll<HTMLButtonElement>('.search-match')[1];
    expect(Array.from(match.children).map((part) => [part.textContent, part.classList.contains('hit')])).toEqual([
      ['return ', false],
      ['main', true],
      ['_loop(', false],
      ['main', true],
      [');', false]
    ]);

    host.state.drawerOpen.set(true);
    match.click();
    await render();
    expect(host.editor.reveal()).toMatchObject({ path: 'studia/lab/src/main.c', line: 7, column: 12, endColumn: 16 });
    expect(host.editor.activePath()).toBe('studia/lab/src/main.c');
    expect(host.state.drawerOpen()).toBe(false);
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'studia/lab/src/main.c', content: 'x', version: 'v1' });

    root.querySelector<HTMLButtonElement>('.search-file')!.click();
    await render();
    expect(texts(root, '.search-match')).toEqual(['cc -o app src/main.c']);
  });

  it('names an invalid regular expression, a failure, no results and the limits', async () => {
    const { root, render } = await setup();
    const regex = () => root.querySelector<HTMLButtonElement>('button[aria-label="Use Regular Expression"]')!;
    const search = async (query: string) => {
      type(field(root), query);
      enter(field(root));
      await render();
      return http.expectOne('/api/search');
    };

    regex().click();
    await render();
    expect(regex().getAttribute('aria-pressed')).toBe('true');
    (await search('(?<=a)b')).flush(null, { status: 400, statusText: 'Bad Request' });
    await render();
    expect(texts(root, '.message')).toEqual(['Invalid or unsupported regular expression.']);

    regex().click(); // a toggle searches again at once
    await render();
    http.expectOne('/api/search').flush(null, { status: 400, statusText: 'Bad Request' });
    await render();
    expect(texts(root, '.message')).toEqual(['Could not search.']);

    (await search('nic')).flush({ files: [], matchCount: 0, limit: null });
    await render();
    expect(texts(root, '.message')).toEqual(['No results found.']);
    (await search('x')).flush({ ...RESULT, limit: 'results' });
    await render();
    expect(texts(root, '.message')).toEqual(['4 results in 2 files', 'Showing the first 2,000 results. Narrow the search to see more.']);
    (await search('y')).flush({ ...RESULT, limit: 'time' });
    await render();
    expect(texts(root, '.message')).toEqual(['4 results in 2 files', 'The search stopped after 10 s, so the results are incomplete.']);
  });

  it('sends the files to include and exclude, and showing Search puts the focus in its field', async () => {
    const { root, render, host } = await setup();
    root.querySelector<HTMLButtonElement>('button[aria-label="Toggle Search Details"]')!.click();
    await render();
    const [include, exclude] = Array.from(root.querySelectorAll<HTMLInputElement>('.glob input'));
    type(field(root), 'main');
    type(include, '*.c, src');
    type(exclude, 'build');
    await render(300);
    expect(http.expectOne('/api/search').request.body).toMatchObject({ query: 'main', include: '*.c, src', exclude: 'build' });

    host.state.show('search');
    await render();
    expect(document.activeElement).toBe(field(root));
  });
});
