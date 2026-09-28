import { expect, test } from '@playwright/test';

import { MAIN, expectEditorToContain, killSessions, login, mockState, openFile, resetMock, treeRow } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

const consolePanel = (page: import('@playwright/test').Page) => page.locator('app-console-panel');
const prompt = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Polecenie' });

test('the panel is plain text without the product name', async ({ page }) => {
  const panel = consolePanel(page);
  await expect(panel).toContainText('KONSOLA · katalog projektów');
  await expect(panel).toContainText('Pusta rozmowa');
  await expect(panel).not.toContainText(/claude/i);
  await expect(page.locator('.topbar')).not.toContainText(/claude/i);
  await expect(page.locator('.statusbar')).toContainText('Konsola: bezczynna');
  await expect(panel.locator('svg, img')).toHaveCount(0);
});

test('a prompt runs with the chosen model, effort and mode and shows the steps', async ({ page, request }) => {
  const panel = consolePanel(page);
  await panel.getByLabel('model').selectOption({ label: 'sonnet-5' });
  await panel.getByLabel('effort').selectOption({ label: 'wysoki' });
  await panel.getByLabel('tryb').selectOption({ label: 'akceptuj edycje' });

  await prompt(page).fill('dodaj komentarz');
  await prompt(page).press('Enter');
  await expect(prompt(page)).toHaveValue('');

  await expect(panel).toContainText('> dodaj komentarz');
  await expect(panel).toContainText(`przeczytano${' '}`);
  await expect(panel).toContainText(/edycja\s+studia\/lab-3-sieci\/src\/main\.c\s+\+1/);
  await expect(panel).toContainText(/uruchomiono\s+make test/);
  await expect(panel).toContainText('6 passed, 0 failed');
  await expect(panel).toContainText('Gotowe. Dodałem komentarz do main.c.');
  await expect(page.locator('.statusbar')).toContainText('Konsola: bezczynna');

  const sent = (await mockState(request)).prompts[0];
  expect(sent).toMatchObject({ text: 'dodaj komentarz', model: 'sonnet', effort: 'high', mode: 'acceptEdits' });
});

test('files changed by the console refresh the explorer and clean open tabs', async ({ page }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await expect(treeRow(page, 'NOTES.md')).toHaveCount(0);

  await prompt(page).fill('dodaj komentarz');
  await prompt(page).press('Enter');

  await expectEditorToContain(page, '// claude');
  await expect(treeRow(page, 'NOTES.md')).toBeVisible();
  await expect(page.locator('.tab__dirty')).toHaveCount(0);
});

test('a tab with unsaved changes is not overwritten by console changes', async ({ page, request }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// mine\n');

  await prompt(page).fill('dodaj komentarz');
  await prompt(page).press('Enter');
  const banner = page.locator('.banner', { hasText: 'Konsola zmieniła ten plik' });
  await expect(banner).toBeVisible();
  await expectEditorToContain(page, '// mine');

  await banner.getByRole('button', { name: 'Wczytaj z dysku' }).click();
  await expectEditorToContain(page, '// claude');
  expect((await mockState(request)).files[MAIN]).not.toContain('// mine');
});

test('permission requests can be allowed or denied', async ({ page }) => {
  const panel = consolePanel(page);
  await prompt(page).fill('zrób commit i push');
  await prompt(page).press('Enter');

  const question = panel.getByRole('group', { name: 'Zezwolić na: git push origin main' });
  await expect(question).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Konsola: czeka na zgodę');
  await question.getByRole('button', { name: 'tak', exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(panel).toContainText('zezwolono: git push origin main');
  await expect(panel).toContainText('Wypchnięto.');

  await prompt(page).fill('jeszcze raz push');
  await prompt(page).press('Enter');
  await panel.getByRole('group', { name: 'Zezwolić na: git push origin main' }).getByRole('button', { name: 'nie' }).click();
  await expect(panel).toContainText('odmówiono: git push origin main');
  await expect(panel).toContainText('Nie wypycham zmian.');
});

test('Esc interrupts a running prompt', async ({ page }) => {
  const panel = consolePanel(page);
  await prompt(page).fill('pracuj długo');
  await prompt(page).press('Enter');
  await expect(panel).toContainText('pracuje… (Esc przerywa)');
  await expect(panel.getByRole('button', { name: 'Nowa' })).toBeDisabled();

  await prompt(page).press('Escape');
  await expect(panel).toContainText('przerwano');
  await expect(panel).not.toContainText('pracuje…');
});

test('the conversation survives a reload and is shared between tabs', async ({ page, context }) => {
  const panel = consolePanel(page);
  await prompt(page).fill('dodaj komentarz');
  await prompt(page).press('Enter');
  await expect(panel).toContainText('Gotowe. Dodałem komentarz do main.c.');

  await page.reload();
  await expect(panel).toContainText('> dodaj komentarz');
  await expect(panel).toContainText('Gotowe. Dodałem komentarz do main.c.');

  const second = await context.newPage();
  await second.goto('/');
  await expect(consolePanel(second)).toContainText('> dodaj komentarz');
  await prompt(page).fill('zrób push');
  await prompt(page).press('Enter');
  await expect(consolePanel(second)).toContainText('> zrób push');
  await expect(consolePanel(second).getByRole('group', { name: /Zezwolić na/ })).toBeVisible();
});

test('"Nowa" starts an empty conversation', async ({ page }) => {
  const panel = consolePanel(page);
  await prompt(page).fill('dodaj komentarz');
  await prompt(page).press('Enter');
  await expect(panel).toContainText('Gotowe.');

  await panel.getByRole('button', { name: 'Nowa' }).click();
  await expect(panel).not.toContainText('dodaj komentarz');
  await expect(panel).toContainText('sesja · rozpoczęta');
});

test('the conversation keeps running while the panel is collapsed', async ({ page }) => {
  await prompt(page).fill('zrób push');
  await prompt(page).press('Enter');
  await consolePanel(page).getByRole('button', { name: 'Zwiń' }).click();
  await expect(page.locator('.statusbar')).toContainText('Konsola: czeka na zgodę');
  await page.getByRole('button', { name: 'Rozwiń konsolę' }).click();
  await expect(consolePanel(page).getByRole('group', { name: /Zezwolić na/ })).toBeVisible();
});

test('a session killed on the server closes the console and returns to login', async ({ page, request }) => {
  await expect(consolePanel(page)).toContainText('Pusta rozmowa');
  await killSessions(request);
  await expect(page).toHaveURL(/\/login\?reason=expired/);
});
