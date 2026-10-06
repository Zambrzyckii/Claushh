import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { AUTH_API, AuthService } from '../../core/auth/auth.service';
import { SessionTimer } from '../../core/auth/session-timer';
import { DeviceLayout } from '../../core/browser/device-layout';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { ProjectContext } from '../../core/project/project-context';
import { RepoStatusStore } from '../../core/project/repo-status';
import { WorkspacesStore } from '../workspaces/workspaces-store';
import { TitleBar } from './title-bar';
import { WorkbenchState } from './workbench-state';

/**
 * Integration: the real TitleBar with WorkbenchState, AuthService, SessionTimer, ProjectContext (router), RepoStatusStore
 * and WorkspacesStore. Only HTTP (HttpTestingController), the page reload (HardNavigation) and the device (DeviceLayout)
 * are replaced.
 */
@Component({
  imports: [TitleBar],
  providers: [SessionTimer, ProjectContext, RepoStatusStore, WorkspacesStore, WorkbenchState],
  template:
    '<app-title-bar (security)="security = security + 1" (logout)="logouts = logouts + 1" (repository)="repository = repository + 1" />'
})
class Host {
  readonly state = inject(WorkbenchState);
  security = 0;
  logouts = 0;
  repository = 0;
}

describe('Title bar (integration)', () => {
  async function setup(phone = false) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: HardNavigation, useValue: { replace: vi.fn(), currentUrl: () => '/' } },
        { provide: DeviceLayout, useValue: { phone: signal(phone), touch: signal(phone) } }
      ]
    });
    const http = TestBed.inject(HttpTestingController);
    const check = TestBed.inject(AuthService).ensureSession();
    http.expectOne(AUTH_API.me).flush({ userName: 'owner', sessionId: 's1', expiresIn: 1800, absoluteExpiresIn: 12 * 3600 });
    await check;
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    for (const request of http.match('/api/workspaces')) {
      request.flush([]);
    }
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, host: fixture.componentInstance };
  }

  it('the account button opens a menu with the user, Security… and Log out, and Esc closes it', async () => {
    const { fixture, root, host } = await setup();
    const account = root.querySelector<HTMLButtonElement>('.topbar__user')!;
    const items = () => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(account.getAttribute('aria-label')).toBe('Account: owner');

    account.click();
    fixture.detectChanges();
    expect(account.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.menu__label')!.textContent!.trim()).toBe('owner');
    expect(items().map((item) => item.textContent!.trim())).toEqual(['Security…', 'Log out']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(root.querySelector('[role="menu"]')).toBeNull();

    account.click();
    fixture.detectChanges();
    items()[0].click();
    fixture.detectChanges();
    expect(host.security).toBe(1);
    expect(root.querySelector('[role="menu"]')).toBeNull();
    account.click();
    fixture.detectChanges();
    items()[1].click();
    expect(host.logouts).toBe(1);
  });

  it('the layout toggles switch the side bar, the panel and the console, and the command centre shows Source Control', async () => {
    const { fixture, root, host } = await setup();
    const toggle = (name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
    expect(['Side bar', 'Panel', 'Console'].map((name) => toggle(name).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true']);
    expect(toggle('Console').title).toBe('Console (Ctrl+Alt+B)');
    expect(toggle('Console').getAttribute('aria-keyshortcuts')).toBe('Control+Alt+B Meta+Alt+B');

    toggle('Side bar').click();
    toggle('Panel').click();
    fixture.detectChanges();
    expect([host.state.sideBarOpen(), host.state.panelOpen()]).toEqual([false, true]);
    expect(toggle('Panel').getAttribute('aria-pressed')).toBe('true');

    const path = root.querySelector<HTMLButtonElement>('.topbar__path')!;
    expect(path.textContent!.trim()).toBe('projects directory');
    path.click();
    expect([host.state.view(), host.state.sideBarOpen()]).toEqual(['scm', true]);
  });

  it('on a phone the bar has the repository button, the countdown and the menu', async () => {
    const { root, host } = await setup(true);
    expect(root.querySelector('.topbar__user')).toBeNull();
    expect(root.querySelector('button[aria-label="Menu"]')).not.toBeNull();
    expect(root.querySelector('[role="timer"]')!.textContent!.trim()).toMatch(/^(29:5\d|30:00)$/);
    root.querySelector<HTMLButtonElement>('.topbar__repo-button')!.click();
    expect(host.repository).toBe(1);
  });
});
