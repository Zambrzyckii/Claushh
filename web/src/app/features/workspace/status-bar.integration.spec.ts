import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { vi } from 'vitest';

import { AUTH_API, AuthService } from '../../core/auth/auth.service';
import { SessionTimer } from '../../core/auth/session-timer';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { ConnectionState, ConsoleConnection } from '../../core/realtime/console-connection';
import { ConsoleEvent } from '../../core/realtime/console-protocol';
import { ConsoleStore } from '../console/console-store';
import { EditorStore } from '../editor/editor-store';
import { StatusBar } from './status-bar';

/**
 * Integration: the real StatusBar with SessionTimer, AuthService, ProjectContext (router), RepoStatusStore, EditorStore and
 * ConsoleStore. Only HTTP (HttpTestingController), SignalR (a connected fake connection) and the page reload are replaced.
 */
class FakeConnection {
  readonly state = signal<ConnectionState>('connected');
  readonly events = new Subject<ConsoleEvent>().asObservable();
  readonly reconnected = new Subject<void>().asObservable();
  async connect() {
    return true;
  }
  async getConversation() {
    return { conversationId: null, events: [] };
  }
}

@Component({
  imports: [StatusBar],
  providers: [SessionTimer, ProjectContext, RepoStatusStore, EditorStore, ConsoleStore, { provide: ConsoleConnection, useClass: FakeConnection }],
  template: '<app-status-bar />'
})
class Host {
  readonly editor = inject(EditorStore);
}

describe('Status bar (integration)', () => {
  let http: HttpTestingController;

  async function setup(expiresIn = 1800) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: HardNavigation, useValue: { replace: vi.fn(), currentUrl: () => '/' } }
      ]
    });
    http = TestBed.inject(HttpTestingController);
    const check = TestBed.inject(AuthService).ensureSession();
    http.expectOne(AUTH_API.me).flush({ userName: 'owner', sessionId: 's1', expiresIn, absoluteExpiresIn: 12 * 3600 });
    await check;
    const fixture = TestBed.createComponent(Host);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
        fixture.detectChanges();
      }
    };
    await settle();
    return { root: fixture.nativeElement as HTMLElement, settle, host: fixture.componentInstance };
  }

  it('shows the branch, the changes, the console state and the unsaved files with their icons', async () => {
    const { root, settle, host } = await setup();
    await TestBed.inject(Router).navigateByUrl('/?repo=studia%2Flab');
    await settle();
    http.expectOne((r) => r.url === '/api/git/status').flush({
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'studia/lab/a.c', status: 'modified' },
        { path: 'studia/lab/b.c', status: 'added' }
      ]
    });
    const opening = host.editor.open('studia/lab/a.c');
    http.expectOne((r) => r.url === '/api/files/content').flush({ path: 'studia/lab/a.c', content: 'x', version: 'v1' });
    await opening;
    host.editor.updateValue('studia/lab/a.c', 'y');
    await settle();

    const text = (selector: string) => root.querySelector(selector)!.textContent!.trim();
    expect(text('.statusbar__branch')).toBe('main');
    expect(root.querySelector('.statusbar__branch .codicon-git-branch')).not.toBeNull();
    expect(text('.statusbar__changes')).toBe('2 changes');
    expect(root.querySelector('.statusbar__changes--dirty .codicon-source-control')).not.toBeNull();
    expect(root.querySelector('.statusbar')!.textContent).toContain('Console: idle');
    expect(text('.statusbar__unsaved')).toBe('Unsaved: 1');
  });

  it('the countdown shows m:ss with its full text as the label, and warns with Extend in the last two minutes', async () => {
    const { root, settle } = await setup(100);
    const timer = root.querySelector<HTMLElement>('[role="timer"]')!;
    expect(timer.textContent!.trim()).toMatch(/^1:(39|40)$/);
    expect(timer.getAttribute('aria-label')).toMatch(/^Session expires in 1:(39|40)$/);
    expect(timer.classList.contains('statusbar__session--warning')).toBe(true);
    expect(timer.querySelector('.codicon-clock')).not.toBeNull();

    Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent!.trim() === 'Extend')!
      .click();
    await settle();
    expect(http.expectOne(AUTH_API.keepAlive).request.method).toBe('POST');
  });
});
