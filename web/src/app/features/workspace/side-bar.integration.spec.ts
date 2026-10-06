import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { EditorStore } from '../editor/editor-store';
import { SearchStore } from '../search/search-store';
import { WorkspacesStore } from '../workspaces/workspaces-store';
import { SideBar } from './side-bar';
import { WorkbenchState } from './workbench-state';

/**
 * Integration: the real SideBar with its Explorer, Search and Source Control views, WorkbenchState, ProjectContext (router),
 * RepoStatusStore, EditorStore, WorkspacesStore and SearchStore. Only HTTP is replaced (HttpTestingController).
 */
@Component({
  imports: [SideBar],
  providers: [ProjectContext, RepoStatusStore, EditorStore, WorkspacesStore, SearchStore, WorkbenchState],
  template: '<app-side-bar />'
})
class Host {
  readonly editor = inject(EditorStore);
  readonly state = inject(WorkbenchState);
}

describe('Side bar (integration)', () => {
  let http: HttpTestingController;

  async function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    const root = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
        fixture.detectChanges();
      }
    };
    await settle();
    respond('/api/workspaces', []);
    await settle();
    return { root, settle, host: fixture.componentInstance };
  }

  /** Answers every pending request to the URL (and, if given, with this `path` parameter). */
  function respond(url: string, body: object, path?: string) {
    for (const request of http.match((r) => r.url === url && (path === undefined || r.params.get('path') === path))) {
      request.flush(body);
    }
  }

  const tab = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${name}"]`)!;
  const texts = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)).map((e) => e.textContent!.trim());

  it('switching views keeps the expanded folder of the explorer', async () => {
    const { root, settle } = await setup();
    respond('/api/files/list', [{ name: 'studia', path: 'studia', kind: 'directory' }], '');
    await settle();
    root.querySelector<HTMLButtonElement>('app-explorer .row')!.click();
    await settle();
    respond('/api/files/list', [{ name: 'lab', path: 'studia/lab', kind: 'directory' }], 'studia');
    await settle();
    expect(texts(root, 'app-explorer .row__name')).toEqual(['studia', 'lab']);

    tab(root, 'Source Control').click();
    await settle();
    expect(tab(root, 'Source Control').getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector<HTMLElement>('#view-explorer')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#view-scm')!.hidden).toBe(false);

    tab(root, 'Explorer').click();
    await settle();
    expect(texts(root, 'app-explorer .row__name')).toEqual(['studia', 'lab']);
    http.expectNone((r) => r.url === '/api/files/list');
  });

  it('the badges of the activity bar count the unsaved files and the changes of the open repository', async () => {
    const { root, settle, host } = await setup();
    const badge = (name: string) => tab(root, name).querySelector('.badge')?.textContent!.trim() ?? null;
    expect([badge('Explorer'), badge('Source Control')]).toEqual([null, null]);

    const opening = host.editor.open('notes.txt');
    respond('/api/files/content', { path: 'notes.txt', content: 'a', version: 'v1' });
    await opening;
    host.editor.updateValue('notes.txt', 'b');
    await TestBed.inject(Router).navigateByUrl('/?repo=studia%2Flab');
    await settle();
    respond('/api/git/status', {
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'studia/lab/a.c', status: 'modified' },
        { path: 'studia/lab/b.c', status: 'untracked' }
      ]
    });
    await settle();
    expect([badge('Explorer'), badge('Source Control')]).toEqual(['1', '2']);
  });

  it('a change in Source Control opens the file with its changes shown, and a deleted file cannot be opened', async () => {
    const { root, settle, host } = await setup();
    await TestBed.inject(Router).navigateByUrl('/?repo=studia%2Flab');
    await settle();
    respond('/api/git/status', {
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'studia/lab/src/a.c', status: 'modified' },
        { path: 'studia/lab/old.c', status: 'deleted' }
      ]
    });
    tab(root, 'Source Control').click();
    host.state.drawerOpen.set(true);
    await settle();
    expect(texts(root, '.scm-change__name')).toEqual(['a.c', 'old.c']);
    expect(texts(root, '.scm-change__dir')).toEqual(['src', '']);
    expect(texts(root, '.scm-change__mark')).toEqual(['M', 'D']);
    const changes = Array.from(root.querySelectorAll<HTMLButtonElement>('.scm-change'));
    expect(changes[1].disabled).toBe(true);

    changes[0].click();
    await settle();
    respond('/api/files/content', { path: 'studia/lab/src/a.c', content: 'new', version: 'v1' });
    await settle();
    respond('/api/git/show', { content: 'old' });
    await settle();
    expect(host.editor.active()).toMatchObject({
      path: 'studia/lab/src/a.c',
      diff: { status: 'ready', original: 'old', isNew: false }
    });
    expect(host.state.drawerOpen()).toBe(false);
  });

  it("the views come in VS Code's order, and Search keeps its query and results while another view is shown", async () => {
    const { root, settle } = await setup();
    expect(Array.from(root.querySelectorAll('[role="tab"]')).map((t) => t.getAttribute('aria-label'))).toEqual([
      'Explorer',
      'Search',
      'Source Control'
    ]);
    tab(root, 'Search').click();
    await settle();
    const field = root.querySelector<HTMLInputElement>('#view-search input[aria-label="Search"]')!;
    field.value = 'main';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    respond('/api/search', { files: [{ path: 'a.c', matches: [{ line: 1, column: 1, preview: 'main', ranges: [[0, 4]] }] }], matchCount: 1, limit: null });
    await settle();

    tab(root, 'Explorer').click();
    await settle();
    expect(root.querySelector<HTMLElement>('#view-search')!.hidden).toBe(true);
    tab(root, 'Search').click();
    await settle();
    expect(field.value).toBe('main');
    expect(texts(root, '#view-search .search-match')).toEqual(['main']);

    root.querySelector<HTMLButtonElement>('#view-search button[aria-label="Clear Search Results"]')!.click();
    await settle();
    expect(field.value).toBe('');
    expect(root.querySelector('#view-search .search-match')).toBeNull();
  });
});
