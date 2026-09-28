import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { AuthService } from '../../core/auth/auth.service';
import { Login } from './login';

describe('Login', () => {
  let login: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;

  function create(query: Record<string, string> = {}) {
    TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { login } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } }
      ]
    });
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    return fixture;
  }

  function fill(root: HTMLElement, values: { userName: string; password: string; totpCode: string }) {
    for (const [id, value] of Object.entries(values)) {
      const input = root.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
  }

  async function submit(fixture: ReturnType<typeof create>) {
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const valid = { userName: 'owner', password: 'secret', totpCode: '123456' };

  beforeEach(() => {
    login = vi.fn();
  });

  it('does not send an incomplete form', async () => {
    const fixture = create();
    fill(fixture.nativeElement, { ...valid, totpCode: '12ab' });
    await submit(fixture);
    expect(login).not.toHaveBeenCalled();
  });

  it('logs in and goes to the sanitized return address', async () => {
    login.mockResolvedValue({ ok: true });
    const fixture = create({ returnUrl: '/projects' });
    fill(fixture.nativeElement, valid);
    await submit(fixture);
    expect(login).toHaveBeenCalledWith(valid);
    expect(navigateByUrl).toHaveBeenCalledWith('/projects');
  });

  it('ignores a return address pointing outside the app', async () => {
    login.mockResolvedValue({ ok: true });
    const fixture = create({ returnUrl: '//evil.example' });
    fill(fixture.nativeElement, valid);
    await submit(fixture);
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('clears the password and code after a failed attempt and shows a generic error', async () => {
    login.mockResolvedValue({ ok: false, reason: 'invalid' });
    const fixture = create();
    const root = fixture.nativeElement as HTMLElement;
    fill(root, valid);
    await submit(fixture);

    expect(root.querySelector<HTMLInputElement>('#password')!.value).toBe('');
    expect(root.querySelector<HTMLInputElement>('#totpCode')!.value).toBe('');
    expect(root.querySelector<HTMLInputElement>('#userName')!.value).toBe('owner');
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('Nieprawidłowe dane logowania.');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('shows the rate limit wait time', async () => {
    login.mockResolvedValue({ ok: false, reason: 'rate-limited', retryAfterSeconds: 30 });
    const fixture = create();
    fill(fixture.nativeElement, valid);
    await submit(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')!.textContent).toContain('30 s');
  });

  it('warns when the server did not confirm the logout', () => {
    const fixture = create({ logout: 'unconfirmed' });
    const notice = (fixture.nativeElement as HTMLElement).querySelector('[role="status"]')!;
    expect(notice.textContent).toContain('serwer nie potwierdził');
    expect(notice.classList).toContain('notice--warning');
  });
});
