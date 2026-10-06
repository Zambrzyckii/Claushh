import crypto from 'node:crypto';
import { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  MOCK_ORIGIN,
  PASSKEY_ORIGIN,
  USER,
  type VirtualAuthenticator,
  addPasskey,
  addVirtualAuthenticator,
  login,
  mockState,
  resetMock
} from './helpers';

/**
 * Passkeys in a real browser (docs/ARCHITECTURE.md, "Tests"): Chromium's virtual authenticator stands for the device.
 * WebAuthn refuses an IP address, so these tests open the portal at http://localhost:4400 and log in there (cookies
 * belong to their host); the mock's /__test/* endpoints stay at 127.0.0.1.
 */

test.use({ baseURL: PASSKEY_ORIGIN });
test.beforeEach(async ({ request }) => resetMock(request));

async function openSecurity(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /Security and sessions/ }).click();
  const security = page.getByRole('dialog', { name: 'Security' });
  await expect(security).toBeVisible();
  return security;
}

async function confirmPassword(security: Locator): Promise<void> {
  await security.getByLabel('Password', { exact: true }).fill(USER.password);
  await security.getByLabel('Authenticator code', { exact: true }).fill(USER.totpCode);
  await security.getByRole('button', { name: 'Confirm' }).click();
}

/** Puts a passkey for localhost that the portal does not know into the authenticator. */
async function addUnknownPasskey(authenticator: VirtualAuthenticator): Promise<void> {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await authenticator.cdp.send('WebAuthn.addCredential', {
    authenticatorId: authenticator.id,
    credential: {
      credentialId: Buffer.from('unknown-passkey').toString('base64'),
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      userHandle: Buffer.from('mock-owner').toString('base64'),
      signCount: 0
    }
  });
}

test('a passkey is added after the password and code, listed as synced, and kept as a discoverable credential', async ({ page, request }) => {
  await login(page);
  const authenticator = await addVirtualAuthenticator(page, true);
  const security = await openSecurity(page);
  await security.getByRole('textbox', { name: 'New passkey name' }).fill('Laptop');
  await security.getByRole('button', { name: 'Add passkey' }).click();
  await expect(security.getByLabel('Password', { exact: true })).toBeVisible();
  expect((await mockState(request)).registrationCount).toBe(0); // 403: no creation options without the password and code

  await confirmPassword(security);
  const row = security.locator('tr.passkey');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-label="Name"]')).toHaveText('Laptop');
  await expect(row.locator('[data-label="Sync"]')).toHaveText('synced');
  await expect(security.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(security.getByRole('textbox', { name: 'New passkey name' })).toHaveValue('');

  const { credentials } = await authenticator.cdp.send('WebAuthn.getCredentials', { authenticatorId: authenticator.id });
  expect(credentials).toHaveLength(1);
  expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' });
  expect((await mockState(request)).passkeyCount).toBe(1);
});

test('a passkey can be renamed', async ({ page }) => {
  await login(page);
  await addVirtualAuthenticator(page);
  const security = await openSecurity(page);
  await addPasskey(security, 'Laptop');

  await security.getByRole('button', { name: 'Rename passkey Laptop' }).click();
  const name = security.getByRole('textbox', { name: 'New name for passkey Laptop' });
  await expect(name).toHaveValue('Laptop');
  await name.fill('Desk');
  await security.getByRole('button', { name: 'Save' }).click();
  await expect(security.locator('tr.passkey [data-label="Name"]')).toHaveText('Desk');
  await expect(security.locator('tr.passkey [data-label="Sync"]')).toHaveText('this device only');
});

test('removing a passkey in a new session asks for the password and code again', async ({ page, request }) => {
  await login(page);
  await addVirtualAuthenticator(page);
  await addPasskey(await openSecurity(page), 'Laptop');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  await login(page);

  const security = await openSecurity(page);
  const questions: string[] = [];
  page.on('dialog', (question) => {
    questions.push(question.message());
    void question.accept();
  });
  await security.getByRole('button', { name: 'Remove passkey Laptop' }).click();
  await confirmPassword(security);
  await expect(security.locator('tr.passkey')).toHaveCount(0);
  await expect(security).toContainText('No passkeys.');
  expect(questions).toEqual(['Remove the passkey “Laptop”? It can no longer be used to log in.']);
  expect((await mockState(request)).passkeyCount).toBe(0);
});

test('a refused user verification cancels the prompt and adds nothing', async ({ page, request }) => {
  await login(page);
  const authenticator = await addVirtualAuthenticator(page);
  await authenticator.cdp.send('WebAuthn.setUserVerified', { authenticatorId: authenticator.id, isUserVerified: false });
  const security = await openSecurity(page);
  await security.getByRole('button', { name: 'Add passkey' }).click();
  await confirmPassword(security);
  await expect(security.getByRole('alert')).toHaveText('Cancelled.');
  const state = await mockState(request);
  expect(state.passkeyCount).toBe(0);
  expect(state.registrationCount).toBe(1); // the creation options were never used: nothing was sent
});

test('a passkey logs in without a user name, and the history shows it', async ({ page }) => {
  await login(page);
  await addVirtualAuthenticator(page);
  await addPasskey(await openSecurity(page), 'Laptop');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page).toHaveURL('/login?logout=ok');

  await page.getByRole('button', { name: 'Log in with a passkey' }).click();
  await page.waitForURL('/');
  const newest = (await openSecurity(page)).locator('tr.login').first();
  await expect(newest.locator('[data-label="Method"]')).toHaveText('passkey');
  await expect(newest.locator('[data-label="Result"]')).toHaveText('succeeded');
});

test('a cancelled passkey prompt sends no login', async ({ page, request }) => {
  await page.goto('/login');
  const authenticator = await addVirtualAuthenticator(page);
  await addUnknownPasskey(authenticator);
  await authenticator.cdp.send('WebAuthn.setUserVerified', { authenticatorId: authenticator.id, isUserVerified: false });
  await page.getByRole('button', { name: 'Log in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText('Passkey login cancelled.');
  const paths = (await mockState(request)).log.map((entry) => entry.path);
  expect(paths).toContain('/api/auth/passkeys/login-options');
  expect(paths).not.toContain('/api/auth/passkeys/login');
});

test('an open passkey prompt does not hold the login lock: another tab logs in with a password meanwhile', async ({ page, context, request }) => {
  await page.goto('/login');
  const authenticator = await addVirtualAuthenticator(page);
  await addUnknownPasskey(authenticator);
  await authenticator.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: authenticator.id, enabled: false });
  const passkey = page.getByRole('button', { name: 'Log in with a passkey' });
  await passkey.click();
  await expect.poll(async () => (await mockState(request)).challengeCount).toBe(1);
  await expect(passkey).toBeDisabled();

  const other = await context.newPage();
  await login(other);
  await expect(other.locator('.topbar__user')).toHaveText('owner');
  await expect(passkey).toBeDisabled(); // the prompt is still open
  expect((await mockState(request)).log.map((entry) => entry.path)).not.toContain('/api/auth/passkeys/login');
});

test('a passkey the portal does not know is refused, and after three failures the wait is shown', async ({ page, request }) => {
  await page.goto('/login');
  await addUnknownPasskey(await addVirtualAuthenticator(page));
  const passkey = page.getByRole('button', { name: 'Log in with a passkey' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await passkey.click();
    await expect
      .poll(async () => (await mockState(request)).log.filter((entry) => entry.path === '/api/auth/passkeys/login').length)
      .toBe(attempt);
    await expect(page.getByRole('alert')).toHaveText('The passkey was not accepted.');
    await expect(passkey).toBeEnabled();
  }
  await passkey.click();
  await expect(page.getByRole('alert')).toHaveText('Too many attempts. Try again in 30 s.');
  await expect(page).toHaveURL('/login');
});

test('on an IP address the passkey button says that passkeys need the domain name', async ({ page }) => {
  await page.goto(`${MOCK_ORIGIN}/login`);
  await page.getByRole('button', { name: 'Log in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText("Passkeys work only at the portal's domain name.");
});
