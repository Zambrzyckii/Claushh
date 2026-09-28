import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { authInterceptor } from '../../core/auth/auth.interceptor';
import { AUTH_API, AuthService } from '../../core/auth/auth.service';
import { SessionTimer } from '../../core/auth/session-timer';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { SecurityDialog } from './security-dialog';

/**
 * Integration: real AuthService + interceptor + SessionTimer + the "Bezpieczeństwo" window.
 * Only HTTP (HttpTestingController), the page reload (HardNavigation) and the clock (fake timers) are replaced.
 */

@Component({
  imports: [SecurityDialog],
  providers: [SessionTimer],
  template: `
    <span class="label">{{ timer.label() }}</span>
    <span class="warning">{{ timer.warning() }}</span>
    <app-security-dialog />
  `
})
class Host {
  readonly timer = inject(SessionTimer);
  readonly dialog = viewChild.required(SecurityDialog);
}

describe('Session and security (integration)', () => {
  let http: HttpTestingController;
  let navigation: { replace: ReturnType<typeof vi.fn>; currentUrl: () => string };

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom does not have a full <dialog>: it is enough that showModal/close toggle the `open` attribute.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    navigation = { replace: vi.fn(), currentUrl: () => '/' };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: HardNavigation, useValue: navigation }
      ]
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loggedIn(expiresIn: number) {
    const auth = TestBed.inject(AuthService);
    const check = auth.ensureSession();
    http.expectOne(AUTH_API.me).flush({ userName: 'owner', expiresIn, absoluteExpiresIn: 12 * 3600 });
    await check;
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const render = async (ms = 0) => {
      await vi.advanceTimersByTimeAsync(ms);
      fixture.detectChanges();
    };
    await render();
    return { fixture, root, render, host: fixture.componentInstance };
  }

  const text = (root: HTMLElement, selector: string) => root.querySelector(selector)!.textContent!.trim();

  it('counts down and warns during the last two minutes', async () => {
    const { root, render } = await loggedIn(150);
    expect(text(root, '.label')).toBe('2:30');
    expect(text(root, '.warning')).toBe('false');

    await render(31_000);
    expect(text(root, '.label')).toBe('1:59');
    expect(text(root, '.warning')).toBe('true');
  });

  it('activity extends the session at most once a minute', async () => {
    const { root, render } = await loggedIn(1800);
    document.dispatchEvent(new KeyboardEvent('keydown'));
    http.expectNone(AUTH_API.keepAlive);

    await render(61_000);
    document.dispatchEvent(new KeyboardEvent('keydown'));
    document.dispatchEvent(new PointerEvent('pointerdown'));
    const keepAlive = http.expectOne(AUTH_API.keepAlive);
    expect(keepAlive.request.method).toBe('POST');
    keepAlive.flush({ expiresIn: 1800, absoluteExpiresIn: 12 * 3600 });
    await render();
    expect(text(root, '.label')).toBe('30:00');
  });

  it('asks the server when the countdown ends and leaves on 401', async () => {
    const { render } = await loggedIn(2);
    await render(3_000);
    http.expectOne(AUTH_API.me).flush(null, { status: 401, statusText: 'Unauthorized' });
    await render();
    expect(navigation.replace).toHaveBeenCalledWith('/login?reason=expired&returnUrl=%2F');
  });

  it('keeps going when another tab already extended the session', async () => {
    const { root, render } = await loggedIn(2);
    await render(3_000);
    http.expectOne(AUTH_API.me).flush({ userName: 'owner', expiresIn: 900, absoluteExpiresIn: 12 * 3600 });
    await render();
    expect(text(root, '.label')).toBe('15:00');
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('the dialog lists sessions and logins and ends another session', async () => {
    const { root, render, host } = await loggedIn(1800);
    host.dialog().open();
    const sessions = [
      { id: 'a', current: true, device: 'Chrome · Linux', ip: '10.0.0.2', createdAt: '2026-09-28T08:00:00Z', lastActivityAt: '2026-09-28T09:00:00Z' },
      { id: 'b', current: false, device: 'Firefox · Windows', ip: '10.0.0.9', createdAt: '2026-09-28T07:00:00Z', lastActivityAt: '2026-09-28T07:30:00Z' }
    ];
    const logins = [
      { at: '2026-09-28T08:00:00Z', ip: '10.0.0.2', device: 'Chrome · Linux', success: true },
      { at: '2026-09-28T07:59:00Z', ip: '10.0.0.2', device: 'Chrome · Linux', success: false }
    ];
    http.expectOne('/api/auth/sessions').flush(sessions);
    http.expectOne('/api/auth/logins').flush(logins);
    await render();

    expect(root.querySelectorAll('tr.session')).toHaveLength(2);
    expect(text(root, 'tr.session--current')).toContain('ta sesja');
    expect(root.querySelectorAll('tr.login--failed')).toHaveLength(1);

    root.querySelector<HTMLButtonElement>('tr.session:not(.session--current) button')!.click();
    const revoke = http.expectOne('/api/auth/sessions/b');
    expect(revoke.request.method).toBe('DELETE');
    revoke.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    http.expectOne('/api/auth/sessions').flush([sessions[0]]);
    http.expectOne('/api/auth/logins').flush(logins);
    await render();
    expect(root.querySelectorAll('tr.session')).toHaveLength(1);
  });
});
