import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { EditorStore } from '../editor/editor-store';
import { Explorer } from '../explorer/explorer';
import { WorkspacesPanel } from './workspaces-panel';
import { WorkspacesStore } from './workspaces-store';

/**
 * Integration: real Workspace panel + WorkspacesStore + ProjectContext (with router) + RepoStatusStore
 * + EditorStore + explorer with badges. Only HTTP is replaced (HttpTestingController).
 */

@Component({
  imports: [WorkspacesPanel, Explorer],
  providers: [ProjectContext, RepoStatusStore, EditorStore, WorkspacesStore],
  template: `
    <app-explorer [root]="project.path()" [decorations]="status.decorations()" />
    <app-workspaces-panel />
  `
})
class Host {
  readonly project = inject(ProjectContext);
  readonly status = inject(RepoStatusStore);
  readonly editor = inject(EditorStore);
}

const WORKSPACES = [
  { name: 'Studia', path: 'studia', repoCount: 1 },
  { name: 'Prywatne', path: 'prywatne', repoCount: 0 }
];
const LAB = {
  name: 'lab',
  path: 'studia/lab',
  branch: 'main',
  changes: 2,
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  lastCommit: { message: 'init', date: new Date(Date.now() - 5 * 60_000).toISOString() }
};

describe('Workspaces (integration)', () => {
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
    return { fixture, host: fixture.componentInstance, root, settle };
  }

  /** Responds to all pending requests to the given URL. */
  function flushAll(url: string, body: object, predicate: (r: TestRequest) => boolean = () => true) {
    for (const req of http.match((r) => r.url === url)) {
      if (predicate(req)) {
        req.flush(body);
      }
    }
  }

  async function loaded() {
    const ctx = await setup();
    flushAll('/api/workspaces', WORKSPACES);
    await ctx.settle();
    flushAll('/api/repos', [LAB]);
    flushAll('/api/files/list', [{ name: 'studia', path: 'studia', kind: 'directory' }]);
    await ctx.settle();
    return ctx;
  }

  const texts = (root: HTMLElement, selector: string) =>
    Array.from(root.querySelectorAll(selector)).map((e) => e.textContent!.trim().replace(/\s+/g, ' '));

  it('shows workspaces and the repositories of the first one', async () => {
    const { root } = await loaded();
    expect(texts(root, '.workspace__name')).toEqual(['Studia', 'Prywatne']);
    expect(texts(root, '.workspace__count')).toEqual(['1 repo', '0 repos']);
    expect(texts(root, 'tr.repo td').slice(0, 5)).toEqual(['lab', 'main', '2 changes', 'init · 5 minutes ago', 'origin ↑1']);
  });

  it('opening a repository updates the address, the explorer root and the git decorations', async () => {
    const { root, settle, host } = await loaded();
    root.querySelector<HTMLButtonElement>('tr.repo button')!.click();
    await settle();

    expect(TestBed.inject(Router).url).toBe('/?repo=studia%2Flab');
    expect(host.project.path()).toBe('studia/lab');
    http.expectOne((r) => r.url === '/api/files/list' && r.params.get('path') === 'studia/lab').flush([
      { name: 'src', path: 'studia/lab/src', kind: 'directory' },
      { name: 'NOTES.md', path: 'studia/lab/NOTES.md', kind: 'file' }
    ]);
    http.expectOne((r) => r.url === '/api/git/status' && r.params.get('repo') === 'studia/lab').flush({
      branch: 'main',
      ahead: 1,
      behind: 0,
      files: [
        { path: 'studia/lab/src/main.c', status: 'modified' },
        { path: 'studia/lab/NOTES.md', status: 'untracked' },
        { path: 'studia/lab/x', status: 'bogus' }
      ]
    });
    await settle();

    expect(texts(root, 'app-explorer .row')).toEqual(['src•', 'NOTES.mdU']);
    expect(root.querySelector('tr.repo button')!.textContent!.trim()).toBe('Opened');
    expect(host.status.changeCount()).toBe(2);
  });

  it('does not send invalid names or clone addresses to the server', async () => {
    const { root, settle } = await loaded();
    const buttons = () => Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    buttons().find((b) => b.textContent!.includes('New workspace'))!.click();
    await settle();
    const name = root.querySelector<HTMLInputElement>('input[aria-label="New workspace name"]')!;
    name.value = 'a/b';
    name.form!.dispatchEvent(new Event('submit'));
    await settle();
    expect(root.textContent).toContain('A name has up to 40 characters');

    buttons().find((b) => b.textContent!.includes('Clone a repository'))!.click();
    await settle();
    const url = root.querySelector<HTMLInputElement>('input[type="url"]')!;
    url.value = 'file:///etc';
    url.form!.dispatchEvent(new Event('submit'));
    await settle();
    expect(root.textContent).toContain('Only https:// URLs are allowed.');

    // The browser sees the host github.com here, and git sees evil.com: a URL with `\` or `@` must not pass.
    for (const [address, message] of [
      ['https://github.com\\@evil.com/org/repo', 'The URL must not contain a user name or password.'],
      ['https://github.com/org/repo?x=1', 'The URL may contain only Latin letters'],
      ['https://github.com/org/../repo', 'Invalid URL. Copy it unchanged']
    ]) {
      url.value = address;
      url.form!.dispatchEvent(new Event('submit'));
      await settle();
      expect(root.textContent).toContain(message);
    }

    http.expectNone((r) => r.method === 'POST');
  });

  it('pull reloads clean open files that it changed', async () => {
    const { root, settle, host } = await loaded();
    const opening = host.editor.open('studia/lab/a.c');
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'studia/lab/a.c', content: 'old', version: 'v1' });
    await opening;

    Array.from(root.querySelectorAll<HTMLButtonElement>('tr.repo button'))
      .find((b) => b.textContent!.trim() === 'Pull')!
      .click();
    await settle();
    http
      .expectOne((r) => r.url === '/api/git/pull' && r.params.get('repo') === 'studia/lab')
      .flush({ message: 'Pulled 1 commit.', changedPaths: ['studia/lab/a.c'] });
    await settle();

    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'studia/lab/a.c', content: 'new', version: 'v2' });
    await settle();
    expect(host.editor.active()).toMatchObject({ value: 'new', version: 'v2' });
    expect(root.querySelector('.repo-message')!.textContent!.trim()).toBe('Pulled 1 commit.');
  });

  it('shows a rejected push with the details from git', async () => {
    const { root, settle } = await loaded();
    Array.from(root.querySelectorAll<HTMLButtonElement>('tr.repo button'))
      .find((b) => b.textContent!.trim() === 'Push')!
      .click();
    await settle();
    http
      .expectOne((r) => r.url === '/api/git/push')
      .flush({ message: '! [rejected] main -> main (fetch first)' }, { status: 409, statusText: 'Conflict' });
    await settle();
    const message = root.querySelector('.repo-message [role="alert"]')!.textContent!;
    expect(message).toContain('Push refused');
    expect(message).toContain('[rejected]');
  });
});
