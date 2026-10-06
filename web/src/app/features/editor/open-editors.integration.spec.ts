import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { Dialogs } from '../../core/browser/dialogs';
import { ProjectContext } from '../../core/project/project-context';
import { WorkbenchState } from '../workspace/workbench-state';
import { EditorStore } from './editor-store';
import { OpenEditors } from './open-editors';

/**
 * Integration: the real OpenEditors with EditorStore, WorkbenchState and ProjectContext (router). Only HTTP
 * (HttpTestingController) and the `confirm()` window (Dialogs) are replaced.
 */
@Component({
  imports: [OpenEditors],
  providers: [ProjectContext, EditorStore, WorkbenchState],
  template: '<app-open-editors />'
})
class Host {
  readonly editor = inject(EditorStore);
  readonly state = inject(WorkbenchState);
}

describe('Open editors (integration)', () => {
  let http: HttpTestingController;
  let confirm: ReturnType<typeof vi.fn>;

  async function setup() {
    confirm = vi.fn(() => false);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: Dialogs, useValue: { confirm } }]
    });
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
    const host = fixture.componentInstance;
    const open = async (path: string) => {
      const opening = host.editor.open(path);
      http.expectOne((r) => r.url === '/api/files/content').flush({ path, content: 'x', version: 'v1' });
      await opening;
      await settle();
    };
    return { root, settle, host, open };
  }

  const texts = (root: HTMLElement, selector: string) => Array.from(root.querySelectorAll(selector)).map((e) => e.textContent!.trim());

  it('lists the open files once expanded, marks the active and the unsaved one, and a click activates a file', async () => {
    const { root, settle, host, open } = await setup();
    await open('studia/lab/src/main.c');
    await open('studia/lab/Makefile');
    expect(root.querySelector('.open-editor')).toBeNull(); // collapsed by default

    root.querySelector<HTMLButtonElement>('.head')!.click();
    await settle();
    const rows = () => Array.from(root.querySelectorAll<HTMLElement>('.open-editor'));
    expect(texts(root, '.open-editor__file')).toEqual(['main.c', 'Makefile']);
    expect(texts(root, '.open-editor__dir')).toEqual(['studia/lab/src', 'studia/lab']);
    expect(rows().map((row) => row.querySelector('img.file-icon')!.getAttribute('src'))).toEqual([
      'file-icons/c.svg',
      'file-icons/makefile.svg'
    ]);
    expect(rows().map((row) => row.classList.contains('open-editor--active'))).toEqual([false, true]);

    host.editor.updateValue('studia/lab/src/main.c', 'changed');
    host.state.drawerOpen.set(true);
    await settle();
    expect(rows()[0].classList.contains('open-editor--dirty')).toBe(true);
    rows()[0].querySelector<HTMLButtonElement>('.open-editor__name')!.click();
    await settle();
    expect(host.editor.activePath()).toBe('studia/lab/src/main.c');
    expect(host.state.drawerOpen()).toBe(false);
  });

  it('closing asks about unsaved changes as a tab does', async () => {
    const { root, settle, host, open } = await setup();
    await open('studia/lab/src/main.c');
    host.editor.updateValue('studia/lab/src/main.c', 'changed');
    host.state.openEditorsExpanded.set(true);
    await settle();

    const close = () => root.querySelector<HTMLButtonElement>('button[aria-label="Close editor main.c"]')!;
    close().click();
    await settle();
    expect(confirm).toHaveBeenCalledWith('main.c has unsaved changes. Close it without saving?');
    expect(host.editor.documents()).toHaveLength(1);

    confirm.mockReturnValue(true);
    close().click();
    await settle();
    expect(host.editor.documents()).toHaveLength(0);
    expect(root.querySelector('.open-editor')).toBeNull();
  });
});
