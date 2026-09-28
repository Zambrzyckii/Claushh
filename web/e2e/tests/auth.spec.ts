import { expect, test } from './fixtures';
import { fillLogin, killSessions, login, mockState, openRepo, resetMock } from './helpers';

test.beforeEach(async ({ request }) => resetMock(request));

async function openSecurity(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Bezpieczeństwo i sesje/ }).click();
  await expect(page.getByRole('dialog', { name: 'Bezpieczeństwo' })).toBeVisible();
}

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
  await page.goto('/');
  await openRepo(page, 'lab-3-sieci'); // app entries in history that "Back" could return to
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
  await page.getByRole('navigation', { name: 'Eksplorator plików' }).getByRole('button', { name: 'Odśwież' }).click();
  await expect(page).toHaveURL(/\/login\?reason=expired/);
  await expect(page.getByRole('status')).toHaveText('Sesja wygasła. Zaloguj się ponownie.');
});

test('an unconfirmed logout stays on the login page and ends the session once the server answers', async ({ page, context, request }) => {
  await login(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('.topbar__user')).toBeVisible();
  // The first logout does not reach the server (e.g. a tunnel error), so the session on the server is still alive.
  let failed = false;
  await page.route('**/api/auth/logout', (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 502 });
  });

  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=unconfirmed');
  await expect(page.getByRole('status')).toHaveText('Wylogowano. Serwer potwierdził zakończenie sesji.');
  await expect(second).toHaveURL('/login?logout=unconfirmed');
  await expect(second.getByRole('status')).toHaveText('Wylogowano. Serwer potwierdził zakończenie sesji.');
  await expect(page.locator('.topbar__user')).toHaveCount(0);

  expect((await mockState(request)).log.filter((l) => l.path === '/api/auth/logout').some((l) => l.hadSession)).toBe(true);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('sid');
});

test('after logging out one can log in again right away', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  await fillLogin(page);
  await page.waitForURL('/');
  await expect(page.locator('.topbar__user')).toBeVisible();
});

test('while the logout is unconfirmed, Back and a new tab do not return to the app', async ({ page, context }) => {
  await login(page);
  await openRepo(page, 'lab-3-sieci'); // history entry with an open repository
  // The server (tunnel) does not confirm the logout, although the session on the server stays alive.
  await context.route('**/api/auth/logout', (route) => route.fulfill({ status: 502 }));
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=unconfirmed');

  await page.goBack();
  await expect(page).toHaveURL('/login?logout=unconfirmed');
  await expect(page.locator('.topbar__user')).toHaveCount(0);

  const other = await context.newPage();
  await other.goto('/');
  await expect(other).toHaveURL('/login?logout=unconfirmed');
  await expect(other.getByRole('status')).toContainText('serwer nie potwierdził');
});

test('after an unconfirmed logout one can log in again even with an outdated XSRF token', async ({ page, context, request }) => {
  await login(page);
  // The network goes down: the logout and its retries do not reach the server.
  await context.route('**/api/auth/logout', (route) => route.fulfill({ status: 502 }));
  let blockedChecks = 0;
  await context.route('**/api/auth/me', (route) => {
    blockedChecks++;
    return route.abort('internetdisconnected');
  });
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=unconfirmed');
  await expect(page.getByRole('status')).toContainText('serwer nie potwierdził');
  await expect.poll(() => blockedChecks).toBeGreaterThan(0); // the first retry from the login screen did not get through
  // The old session expires on the server, and the XSRF token in the browser is still issued for it. Then the network comes back
  // (the next retry only in 3 s, so the login below will not get a token from it).
  await killSessions(request, { keepSockets: true });
  await context.unroute('**/api/auth/me');

  await fillLogin(page);
  await page.waitForURL('/');
  await expect(page.locator('.topbar__user')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('claushh-pending-logout'))).toBeNull();
});

test('logging in again ends the old session that the unconfirmed logout left alive', async ({ page, context, request }) => {
  await login(page);
  await context.route('**/api/auth/logout', (route) => route.fulfill({ status: 502 })); // logout does not get through
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=unconfirmed');
  const oldSession = await page.evaluate(() => localStorage.getItem('claushh-pending-logout'));
  expect(oldSession).toBeTruthy();

  await fillLogin(page);
  await page.waitForURL('/');
  // The new session ends the old one by id (with its own XSRF token), because it could not log it out itself.
  await expect.poll(async () => (await mockState(request)).log.filter((l) => l.path === 'revoke').map((l) => l.id)).toContain(oldSession);
  await openSecurity(page);
  await expect(page.getByRole('dialog', { name: 'Bezpieczeństwo' }).locator('tr.session')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('claushh-pending-logout'))).toBeNull();

  // The login screen is not in history: "Back" does not return to a stale logout warning.
  // We check all navigations after "Back", not only the final URL (the guard would send it back to the app anyway).
  await page.keyboard.press('Escape');
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });
  await page.goBack();
  await page.waitForTimeout(500);
  expect(visited.some((url) => url.includes('logout=unconfirmed'))).toBe(false);
});

test('a link from another site to the unconfirmed-logout page does not log the user out', async ({ page, request }) => {
  await login(page);
  await page.goto('/login?logout=unconfirmed');
  // Without the app marker it is a regular login screen: a logged-in user goes back to the app.
  await expect(page).toHaveURL('/');
  await expect(page.locator('.topbar__user')).toBeVisible();
  await page.waitForTimeout(4000); // time for any automatic retries
  expect((await mockState(request)).log.filter((l) => l.path === '/api/auth/logout')).toHaveLength(0);
});

test.describe('Content-Security-Policy', () => {
  test.use({ allowCspViolations: true });

  test('strings cannot become HTML or script addresses (Trusted Types)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#userName')).toBeVisible();
    const results = await page.evaluate(() => {
      const attempt = (action: () => void) => {
        try {
          action();
          return 'dozwolone';
        } catch {
          return 'zablokowane';
        }
      };
      return {
        innerHTML: attempt(() => (document.createElement('div').innerHTML = '<img src=x onerror=alert(1)>')),
        scriptSrc: attempt(() => (document.createElement('script').src = 'https://evil.example/x.js')),
        // Same-origin URLs that CSP alone would let through, and only the Trusted Types policy blocks:
        workerInSubdirectory: attempt(() => new Worker('/assets/x.js')),
        workerWithQuery: attempt(() => new Worker('/x.js?y=1')),
        workerNotJs: attempt(() => new Worker('/x.txt'))
      };
    });
    expect(results).toEqual({
      innerHTML: 'zablokowane',
      scriptSrc: 'zablokowane',
      workerInSubdirectory: 'zablokowane',
      workerWithQuery: 'zablokowane',
      workerNotJs: 'zablokowane'
    });
  });
});

test.describe('embedding in a frame', () => {
  test.use({ allowCspViolations: true });

  test('the server forbids showing the portal in a frame of another page', async ({ page, baseURL }) => {
    await page.setContent(`<iframe src="${baseURL}/login"></iframe>`);
    await expect.poll(() => page.frames()[1]?.url()).toMatch(/^chrome-error:/);
    await expect(page.frameLocator('iframe').locator('#userName')).toHaveCount(0);
  });

  test('without the header the app itself refuses to start in a frame', async ({ page, baseURL }) => {
    await page.route('**/login', async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      delete headers['content-security-policy'];
      delete headers['x-frame-options'];
      await route.fulfill({ response, headers });
    });
    await page.setContent(`<iframe src="${baseURL}/login"></iframe>`);
    await expect(page.frameLocator('iframe').locator('body')).toHaveText('Ta strona nie może być wyświetlana w ramce.');
    await expect(page.frameLocator('iframe').locator('#userName')).toHaveCount(0);
  });
});
