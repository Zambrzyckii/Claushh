import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { PASSKEYS_API } from '../../core/api/passkeys-api';
import { authInterceptor } from '../../core/auth/auth.interceptor';
import { SessionTimer } from '../../core/auth/session-timer';
import { Dialogs } from '../../core/browser/dialogs';
import { HardNavigation } from '../../core/browser/hard-navigation';
import { WebAuthn } from '../../core/browser/webauthn';
import { SecurityDialog } from './security-dialog';

/**
 * Integration: the passkeys of the Security window. Real SecurityDialog, PasskeysStore, PasskeysApi, AuthService and
 * interceptor; only HTTP (HttpTestingController), the page reload (HardNavigation), `confirm()` (Dialogs), the
 * browser's passkey prompt (WebAuthn) and the clock (fake timers) are replaced.
 */

@Component({
  imports: [SecurityDialog],
  providers: [SessionTimer],
  template: '<app-security-dialog />'
})
class Host {
  readonly dialog = viewChild.required(SecurityDialog);
}

const LAPTOP = { id: 'k1', name: 'Laptop', createdAt: '2026-10-05T12:03:00Z', synced: true };
const PHONE = { id: 'k2', name: 'Phone', createdAt: '2026-10-05T12:30:00Z', synced: false };
const OPTIONS = {
  rp: { name: 'localhost', id: 'localhost' },
  user: { id: 'b3duZXI', name: 'owner', displayName: 'owner' },
  challenge: 'Y2hhbGxlbmdl',
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 300000,
  excludeCredentials: [{ type: 'public-key', id: 'k1' }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
};
const CREDENTIAL = {
  id: 'k2',
  rawId: 'k2',
  type: 'public-key',
  authenticatorAttachment: 'platform',
  clientExtensionResults: {},
  response: { clientDataJSON: 'e30', attestationObject: 'oA', authenticatorData: 'AA', transports: ['internal'] }
};
const NAME_RULE = 'A passkey name has 1 to 64 characters and no control characters.';
const FORBIDDEN = { status: 403, statusText: 'Forbidden' };
const NO_CONTENT = { status: 204, statusText: 'No Content' };

describe('Passkeys in the Security window (integration)', () => {
  let http: HttpTestingController;
  let navigation: { replace: ReturnType<typeof vi.fn>; currentUrl: () => string };
  let confirm: ReturnType<typeof vi.fn>;
  let webAuthn: {
    available: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };

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
    confirm = vi.fn(() => true);
    webAuthn = { available: vi.fn(() => true), create: vi.fn(), get: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: HardNavigation, useValue: navigation },
        { provide: Dialogs, useValue: { confirm } },
        { provide: WebAuthn, useValue: webAuthn }
      ]
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
      expect(navigation.replace).not.toHaveBeenCalled(); // a 403 or 404 here never ends the session
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      TestBed.resetTestingModule();
    }
  });

  /** Opens the window and answers its three lists. */
  async function open(passkeys: object[], logins: object[] = []) {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const render = async () => {
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
    };
    fixture.componentInstance.dialog().open();
    http.expectOne('/api/auth/sessions').flush([]);
    http.expectOne('/api/auth/logins').flush(logins);
    http.expectOne({ method: 'GET', url: PASSKEYS_API.passkeys }).flush(passkeys);
    await render();
    return { root, render };
  }

  const alert = (root: HTMLElement) =>
    root.querySelector('section[aria-labelledby="passkeys-title"] [role="alert"]')?.textContent?.trim() ?? null;
  const rows = (root: HTMLElement) => Array.from(root.querySelectorAll('tr.passkey'));
  const cell = (row: Element, label: string) => row.querySelector(`[data-label="${label}"]`)!.textContent!.trim();
  const value = (root: HTMLElement, selector: string) => root.querySelector<HTMLInputElement>(selector)!.value;

  it('lists the passkeys with the date they were added and whether they sync, and the history shows how each login was made', async () => {
    const { root } = await open(
      [LAPTOP, PHONE],
      [
        { at: '2026-10-05T12:31:00Z', ip: '10.0.0.2', device: 'Safari · iOS', success: true, method: 'passkey' },
        { at: '2026-10-05T12:00:00Z', ip: '10.0.0.2', device: 'Chrome · Linux', success: false, method: 'password' }
      ]
    );
    expect(rows(root).map((row) => [cell(row, 'Name'), cell(row, 'Sync')])).toEqual([
      ['Laptop', 'synced'],
      ['Phone', 'this device only']
    ]);
    expect(cell(rows(root)[0], 'Added')).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
    expect(Array.from(root.querySelectorAll('tr.login')).map((row) => cell(row, 'Method'))).toEqual(['passkey', 'password']);
    expect(button(root, 'Add passkey')).toBeDefined();
  });

  it('adding asks for the password and code after a 403, then creates the passkey and lists it', async () => {
    webAuthn.create.mockResolvedValue({ ok: true, credential: CREDENTIAL });
    const { root, render } = await open([LAPTOP]);
    fill(root, 'input[aria-label="New passkey name"]', ' Phone ');
    submit(root, 'form.passkey-add');
    await render();
    http.expectOne(PASSKEYS_API.creationOptions).flush(null, FORBIDDEN);
    await render();
    expect(webAuthn.create).not.toHaveBeenCalled();
    expect(root.querySelector('form.passkey-add')).toBeNull();

    fill(root, '#reauth-password', 'secret');
    fill(root, '#reauth-code', '123456');
    submit(root, 'form.reauth');
    await render();
    const reauth = http.expectOne(PASSKEYS_API.reauthenticate);
    expect(reauth.request.body).toEqual({ password: 'secret', totpCode: '123456' });
    reauth.flush(null, NO_CONTENT);
    await render();
    http.expectOne(PASSKEYS_API.creationOptions).flush(OPTIONS);
    await render();
    expect(webAuthn.create).toHaveBeenCalledExactlyOnceWith(OPTIONS);
    const add = http.expectOne({ method: 'POST', url: PASSKEYS_API.passkeys });
    expect(add.request.body).toEqual({ credential: CREDENTIAL, name: 'Phone' });
    add.flush(PHONE, { status: 201, statusText: 'Created' });
    await render();
    http.expectOne({ method: 'GET', url: PASSKEYS_API.passkeys }).flush([LAPTOP, PHONE]);
    await render();

    expect(rows(root).map((row) => cell(row, 'Name'))).toEqual(['Laptop', 'Phone']);
    expect(root.querySelector('form.reauth')).toBeNull();
    expect(value(root, 'input[aria-label="New passkey name"]')).toBe('');
    expect(alert(root)).toBeNull();
  });

  it('a cancelled prompt sends nothing to the server', async () => {
    webAuthn.create.mockResolvedValue({ ok: false, reason: 'cancelled' });
    const { root, render } = await open([LAPTOP]);
    submit(root, 'form.passkey-add');
    await render();
    http.expectOne(PASSKEYS_API.creationOptions).flush(OPTIONS);
    await render();
    expect(webAuthn.create).toHaveBeenCalledOnce();
    expect(alert(root)).toBe('Cancelled.');
    http.expectNone({ method: 'POST', url: PASSKEYS_API.passkeys });
    expect(rows(root)).toHaveLength(1);
  });

  it.each([
    ['already-registered', 'This device already has a passkey for the portal.'],
    ['not-here', "Passkeys work only at the portal's domain name."],
    ['failed', 'The passkey could not be added. Try again.']
  ])('a prompt that ends with "%s" shows "%s" and adds nothing', async (reason, message) => {
    webAuthn.create.mockResolvedValue({ ok: false, reason });
    const { root, render } = await open([LAPTOP]);
    submit(root, 'form.passkey-add');
    await render();
    http.expectOne(PASSKEYS_API.creationOptions).flush(OPTIONS);
    await render();
    expect(alert(root)).toBe(message);
    http.expectNone({ method: 'POST', url: PASSKEYS_API.passkeys });
  });

  it("the limit and a refused credential show the server's text", async () => {
    webAuthn.create.mockResolvedValue({ ok: true, credential: CREDENTIAL });
    const { root, render } = await open([LAPTOP]);
    submit(root, 'form.passkey-add');
    await render();
    http
      .expectOne(PASSKEYS_API.creationOptions)
      .flush({ message: 'There are 10 passkeys already. Remove one first.' }, { status: 409, statusText: 'Conflict' });
    await render();
    expect(alert(root)).toBe('There are 10 passkeys already. Remove one first.');
    expect(webAuthn.create).not.toHaveBeenCalled();

    submit(root, 'form.passkey-add');
    await render();
    http.expectOne(PASSKEYS_API.creationOptions).flush(OPTIONS);
    await render();
    http
      .expectOne({ method: 'POST', url: PASSKEYS_API.passkeys })
      .flush({ message: NAME_RULE }, { status: 400, statusText: 'Bad Request' });
    await render();
    expect(alert(root)).toBe(NAME_RULE);
  });

  it('names are checked before anything is sent, and a rename that finds the passkey gone refreshes the list', async () => {
    const { root, render } = await open([LAPTOP, PHONE]);
    fill(root, 'input[aria-label="New passkey name"]', 'x'.repeat(65));
    submit(root, 'form.passkey-add');
    await render();
    expect(alert(root)).toBe(NAME_RULE);
    http.expectNone(PASSKEYS_API.creationOptions);

    button(root, 'Rename passkey Laptop').click();
    await render();
    expect(value(root, 'form.passkey-rename input')).toBe('Laptop');
    expect(alert(root)).toBeNull();
    fill(root, 'form.passkey-rename input', 'Desk\u0007');
    submit(root, 'form.passkey-rename');
    await render();
    expect(alert(root)).toBe(NAME_RULE);
    fill(root, 'form.passkey-rename input', '   ');
    submit(root, 'form.passkey-rename');
    await render();
    expect(alert(root)).toBe(NAME_RULE);
    http.expectNone((request) => request.method === 'PATCH');

    fill(root, 'form.passkey-rename input', ' Desk ');
    submit(root, 'form.passkey-rename');
    await render();
    const rename = http.expectOne({ method: 'PATCH', url: `${PASSKEYS_API.passkeys}/k1` });
    expect(rename.request.body).toEqual({ name: 'Desk' });
    rename.flush(null, { status: 404, statusText: 'Not Found' });
    await render();
    http.expectOne({ method: 'GET', url: PASSKEYS_API.passkeys }).flush([PHONE]);
    await render();
    expect(rows(root).map((row) => cell(row, 'Name'))).toEqual(['Phone']);
    expect(root.querySelector('form.passkey-rename')).toBeNull();
    expect(alert(root)).toBeNull();
  });

  it('removing asks first, and a 403 asks for the password and code before it removes', async () => {
    const { root, render } = await open([LAPTOP]);
    confirm.mockReturnValueOnce(false);
    button(root, 'Remove passkey Laptop').click();
    await render();
    expect(confirm).toHaveBeenCalledExactlyOnceWith('Remove the passkey “Laptop”? It can no longer be used to log in.');
    http.expectNone((request) => request.method === 'DELETE');

    button(root, 'Remove passkey Laptop').click();
    await render();
    http.expectOne({ method: 'DELETE', url: `${PASSKEYS_API.passkeys}/k1` }).flush(null, FORBIDDEN);
    await render();
    fill(root, '#reauth-password', 'secret');
    fill(root, '#reauth-code', '123456');
    submit(root, 'form.reauth');
    await render();
    http.expectOne(PASSKEYS_API.reauthenticate).flush(null, NO_CONTENT);
    await render();
    http.expectOne({ method: 'DELETE', url: `${PASSKEYS_API.passkeys}/k1` }).flush(null, NO_CONTENT);
    await render();
    http.expectOne({ method: 'GET', url: PASSKEYS_API.passkeys }).flush([]);
    await render();
    expect(confirm).toHaveBeenCalledTimes(2); // the repeat after the password and code asks nothing more
    expect(root.querySelector('section[aria-labelledby="passkeys-title"]')!.textContent).toContain('No passkeys.');
  });

  it('a wrong password or code says so, and too many attempts show the wait and clear only the code', async () => {
    const { root, render } = await open([LAPTOP]);
    submit(root, 'form.passkey-add');
    await render();
    http.expectOne(PASSKEYS_API.creationOptions).flush(null, FORBIDDEN);
    await render();

    fill(root, '#reauth-password', 'wrong');
    fill(root, '#reauth-code', '123456');
    submit(root, 'form.reauth');
    await render();
    http.expectOne(PASSKEYS_API.reauthenticate).flush(null, FORBIDDEN);
    await render();
    expect(alert(root)).toBe('Wrong password or code.');
    expect(value(root, '#reauth-password')).toBe('');
    expect(value(root, '#reauth-code')).toBe('');

    fill(root, '#reauth-password', 'secret');
    fill(root, '#reauth-code', '654321');
    submit(root, 'form.reauth');
    await render();
    http
      .expectOne(PASSKEYS_API.reauthenticate)
      .flush(null, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '30' } });
    await render();
    expect(alert(root)).toBe('Too many attempts. Try again in 30 s.');
    expect(value(root, '#reauth-password')).toBe('secret');
    expect(value(root, '#reauth-code')).toBe('');
    expect(webAuthn.create).not.toHaveBeenCalled();
    http.expectNone(PASSKEYS_API.creationOptions);
  });

  it('without passkeys in this browser the list stays and adding is not offered', async () => {
    webAuthn.available.mockReturnValue(false);
    const { root } = await open([LAPTOP]);
    expect(rows(root)).toHaveLength(1);
    expect(root.querySelector('form.passkey-add')).toBeNull();
    expect(root.textContent).toContain('This browser cannot create passkeys here.');
    expect(button(root, 'Remove passkey Laptop')).toBeDefined();
  });
});

function button(root: HTMLElement, name: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll('button')).find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent!.trim()) === name
  )!;
}

function fill(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function submit(root: HTMLElement, selector: string): void {
  root.querySelector<HTMLFormElement>(selector)!.dispatchEvent(new Event('submit', { cancelable: true }));
}
