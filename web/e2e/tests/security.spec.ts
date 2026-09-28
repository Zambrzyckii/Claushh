import { Browser, Page, expect, test } from '@playwright/test';

import { fillLogin, login, mockState, resetMock, setSessionTimeout } from './helpers';

test.beforeEach(async ({ request }) => resetMock(request));

const countdown = (page: Page) => page.getByRole('timer');

/** A second browser (separate cookies) pretends to be a second device. */
async function otherDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

async function openSecurity(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Bezpieczeństwo i sesje/ }).click();
  await expect(page.getByRole('dialog', { name: 'Bezpieczeństwo' })).toBeVisible();
}

test('the top bar counts down the session', async ({ page }) => {
  await login(page);
  await expect(countdown(page)).toHaveText(/Sesja wygasa za (29:5\d|30:00)/);
  await expect(page.getByRole('button', { name: 'Przedłuż' })).toHaveCount(0);
});

test('near the end the countdown warns and can be extended', async ({ page, request }) => {
  await setSessionTimeout(request, 100);
  await login(page);
  await expect(countdown(page)).toHaveText(/Sesja wygasa za 1:(3\d|40)/);
  await expect(countdown(page)).toHaveClass(/topbar__session--warning/);
  await expect(countdown(page)).toHaveText(/1:3[0-7]/, { timeout: 8000 });

  await page.getByRole('button', { name: 'Przedłuż' }).click();
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

test('the security dialog lists sessions and logins and can end another session', async ({ page, browser }) => {
  const phone = await otherDevice(browser);
  await phone.goto('/login');
  await fillLogin(phone, { password: 'zle' });
  await expect(phone.getByRole('alert')).toBeVisible();
  await fillLogin(phone);
  await phone.waitForURL('/');
  await login(page);

  await openSecurity(page);
  const dialog = page.getByRole('dialog', { name: 'Bezpieczeństwo' });
  await expect(dialog.locator('tr.session')).toHaveCount(2);
  await expect(dialog.locator('tr.session--current')).toContainText('ta sesja');
  await expect(dialog.locator('tr.session').first()).toContainText(/Chrome · (Windows|Linux|macOS)/);
  await expect(dialog.locator('tr.login')).toHaveCount(3);
  await expect(dialog.locator('tr.login--failed')).toHaveCount(1);
  await expect(dialog.locator('tr.login').last()).toContainText('nieudane');

  await dialog.locator('tr.session:not(.session--current)').getByRole('button', { name: /Wyloguj sesję/ }).click();
  await expect(dialog.locator('tr.session')).toHaveCount(1);
  await expect(phone).toHaveURL(/\/login\?reason=expired/);

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.topbar__user')).toBeVisible();
});

test('"Wyloguj wszędzie" ends every session, including this one', async ({ page, browser, request }) => {
  const laptop = await otherDevice(browser);
  await login(laptop);
  await login(page);

  await openSecurity(page);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Wyloguj wszędzie' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  await expect(laptop).toHaveURL(/\/login\?reason=expired/);
  const log = (await mockState(request)).log.map((l) => l.path);
  expect(log).toContain('revoke-others');
  expect(log).toContain('/api/auth/logout');
});
