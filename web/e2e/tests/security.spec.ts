import { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  MAIN,
  expectEditorToContain,
  fillLogin,
  killSessions,
  login,
  mockState,
  openFile,
  openSecurity,
  resetMock,
  setSessionTimeout
} from './helpers';

test.beforeEach(async ({ request }) => resetMock(request));

const countdown = (page: Page) => page.getByRole('timer');

test('the top bar counts down the session', async ({ page }) => {
  await login(page);
  await expect(countdown(page)).toHaveAttribute('aria-label', /Session expires in (29:5\d|30:00)/);
  await expect(page.getByRole('button', { name: 'Extend' })).toHaveCount(0);
});

test('near the end the countdown warns and can be extended', async ({ page, request }) => {
  await setSessionTimeout(request, 100);
  await login(page);
  await expect(countdown(page)).toHaveAttribute('aria-label', /Session expires in 1:(3\d|40)/);
  await expect(countdown(page)).toHaveClass(/statusbar__session--warning/);
  await expect(countdown(page)).toHaveText(/1:3[0-7]/, { timeout: 8000 });

  await page.getByRole('button', { name: 'Extend' }).click();
  await expect(countdown(page)).toHaveText(/1:(39|40)/);
  expect((await mockState(request)).log.filter((l) => l.path === 'keepalive')).toHaveLength(1);
});

test('activity extends the session at most once a minute', async ({ page, request }) => {
  await page.clock.install();
  await login(page);
  await expect(countdown(page)).toBeVisible(); // the countdown (and activity tracking) is already running
  await page.keyboard.press('Shift');
  expect((await mockState(request)).log.filter((l) => l.path === 'keepalive')).toHaveLength(0);

  await page.clock.fastForward('01:01');
  await page.mouse.click(700, 300);
  await page.keyboard.press('Shift');
  await page.mouse.click(700, 320);
  await expect.poll(async () => (await mockState(request)).log.filter((l) => l.path === 'keepalive').length).toBe(1);
});

test('an expired session sends the user back to login when the countdown ends', async ({ page, request }) => {
  await setSessionTimeout(request, 3);
  await login(page);
  await expect(page).toHaveURL(/\/login\?reason=expired/, { timeout: 15000 });
});

test('the security dialog lists sessions and logins and can end another session', async ({ page, newDevice }) => {
  const phone = await newDevice();
  await phone.goto('/login');
  await fillLogin(phone, { password: 'zle' });
  await expect(phone.getByRole('alert')).toBeVisible();
  await fillLogin(phone);
  await phone.waitForURL('/');
  await login(page);

  await openSecurity(page);
  const dialog = page.getByRole('dialog', { name: 'Security' });
  await expect(dialog.locator('tr.session')).toHaveCount(2);
  await expect(dialog.locator('tr.session--current')).toContainText('this session');
  await expect(dialog.locator('tr.session').first()).toContainText(/Chrome · (Windows|Linux|macOS)/);
  await expect(dialog.locator('tr.login')).toHaveCount(3);
  await expect(dialog.locator('tr.login--failed')).toHaveCount(1);
  await expect(dialog.locator('tr.login').last()).toContainText('failed');

  await dialog.locator('tr.session:not(.session--current)').getByRole('button', { name: /Log out session/ }).click();
  await expect(dialog.locator('tr.session')).toHaveCount(1);
  await expect(phone).toHaveURL(/\/login\?reason=expired/);

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.topbar__user')).toBeVisible();
});

test('"Log out everywhere" ends every session, including this one', async ({ page, newDevice, request }) => {
  const laptop = await newDevice();
  await login(laptop);
  await login(page);

  await openSecurity(page);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Log out everywhere' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  await expect(laptop).toHaveURL(/\/login\?reason=expired/);
  const log = (await mockState(request)).log.map((l) => l.path);
  expect(log).toContain('revoke-others');
  expect(log).toContain('/api/auth/logout');
});

test('without an answer from the server the session still ends on this screen after the deadline', async ({ page, request }) => {
  await page.clock.install();
  await setSessionTimeout(request, 5);
  await login(page);
  await expect(countdown(page)).toBeVisible();
  // The server (or the network, the tunnel) stops responding.
  let checks = 0;
  await page.route('**/api/**', (route) => {
    if (route.request().url().endsWith('/api/auth/me')) checks++;
    return route.abort('internetdisconnected');
  });

  await page.clock.fastForward('00:06');
  await expect(countdown(page)).toHaveAttribute('aria-label', 'Session expires in 0:00');
  await expect.poll(() => checks).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward('00:15');
  await expect.poll(() => checks).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300); // the response (network error) has had time to reach the page
  await expect(page).toHaveURL('/'); // a brief lack of response does not log out yet

  await page.clock.fastForward('00:30');
  await expect(page).toHaveURL(/\/login\?reason=expired/);
});

test('the server closes the live connections of a session that expired', async ({ page, request }) => {
  // The countdown in the browser still shows almost 30 minutes: only the server can notice the shortened expiry,
  // by closing the session's open WebSockets (without that the page would stay logged in).
  await login(page);
  await expect(page.locator('app-console-panel')).toContainText('Empty conversation');
  await setSessionTimeout(request, 1);
  await expect(page).toHaveURL(/\/login\?reason=expired/, { timeout: 10_000 });
});

test('a hub call with a session the server no longer has closes the connection', async ({ page, request }) => {
  await login(page);
  await expect(page.locator('app-console-panel')).toContainText('Empty conversation');
  // The session disappears on the server, but open WebSockets stay: only the check on a hub invocation will notice it.
  await killSessions(request, { keepSockets: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('dodaj komentarz');
  await prompt.press('Enter');
  await expect(page).toHaveURL(/\/login\?reason=expired/);
  expect((await mockState(request)).prompts).toHaveLength(0);
});

test('"Log out everywhere" with unsaved files asks a single question before ending any session', async ({ page, request }) => {
  await login(page);
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('// niezapisane');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  await openSecurity(page);

  const questions: string[] = [];
  page.on('dialog', (dialog) => {
    questions.push(dialog.message());
    void (questions.length === 1 ? dialog.dismiss() : dialog.accept());
  });
  await page.getByRole('button', { name: 'Log out everywhere' }).click();
  await expect.poll(() => questions).toEqual(['Log out every session, this one too? Unsaved files (1) will be discarded.']);
  expect((await mockState(request)).log.map((l) => l.path)).not.toContain('revoke-others');
  await expect(page.locator('.topbar__user')).toBeVisible();

  await page.getByRole('button', { name: 'Log out everywhere' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  expect(questions).toHaveLength(2);
  const log = (await mockState(request)).log.map((l) => l.path);
  expect(log).toContain('revoke-others');
  expect(log).toContain('/api/auth/logout');
});
