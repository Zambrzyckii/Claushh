import { expect, test } from '@playwright/test';

import { fillLogin, killSessions, login, mockState, resetMock } from './helpers';

test.beforeEach(async ({ request }) => resetMock(request));

test('anonymous user is sent to login with a return address', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/login?returnUrl=%2F');
});

test('wrong credentials show a generic error and clear secret fields', async ({ page, request }) => {
  await page.goto('/login');
  await fillLogin(page, { password: 'wrong' });
  await expect(page.getByRole('alert')).toHaveText('Nieprawidłowe dane logowania.');
  await expect(page.locator('#password')).toHaveValue('');
  await expect(page.locator('#totpCode')).toHaveValue('');
  await expect(page.locator('#userName')).toHaveValue('owner');
  expect((await mockState(request)).log.find((l) => l.path === '/api/auth/login')?.xsrf).toBe(true);
});

test('login keeps the session out of JavaScript and web storage', async ({ page }) => {
  await login(page);
  await expect(page.locator('.topbar__user')).toHaveText('owner');
  expect(await page.evaluate(() => document.cookie)).not.toContain('sid');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  await page.goto('/login');
  await expect(page).toHaveURL('/');
});

test('logout ends the server session, clears every tab and blocks the back button', async ({ page, context, request }) => {
  await login(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('.topbar__user')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('probe', 'x'));

  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  await expect(page.getByRole('status')).toHaveText('Wylogowano.');
  await expect(second).toHaveURL(/\/login/);

  const logout = (await mockState(request)).log.find((l) => l.path === '/api/auth/logout');
  expect(logout).toMatchObject({ xsrf: true, hadSession: true });
  expect((await context.cookies()).map((c) => c.name)).not.toContain('sid');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('.topbar__user')).toHaveCount(0);
});

test('return address pointing to another host is ignored', async ({ page }) => {
  await page.goto('/login?returnUrl=%2F%2Fevil.example');
  await fillLogin(page);
  await expect(page).toHaveURL('/');
});

test('too many attempts show the waiting time', async ({ page }) => {
  await page.goto('/login');
  for (let i = 0; i < 4; i++) {
    await fillLogin(page, { password: 'bad' });
    await expect(page.getByRole('alert')).toBeVisible();
  }
  await expect(page.getByRole('alert')).toContainText('30 s');
});

test('a 401 from the API sends the user back to login', async ({ page, request }) => {
  await login(page);
  await expect(page.locator('app-console-panel')).toContainText('Pusta rozmowa'); // console connected
  await killSessions(request, { keepSockets: true });
  await page.getByRole('button', { name: 'Odśwież' }).click();
  await expect(page).toHaveURL(/\/login\?reason=expired/);
  await expect(page.getByRole('status')).toHaveText('Sesja wygasła. Zaloguj się ponownie.');
});
