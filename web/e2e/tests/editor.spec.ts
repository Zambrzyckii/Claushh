import { expect, test } from '@playwright/test';

import { MAIN, editorText, expectEditorToContain, login, mockState, openFile, resetMock, setFile, treeRow } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

test('explorer loads directories lazily, directories first', async ({ page, request }) => {
  await expect(page.locator('.row__name')).toHaveText(['prywatne', 'studia']);
  await openFile(page, 'studia/lab-3-sieci');
  await expect(page.locator('.row__name')).toHaveText([
    'prywatne',
    'studia',
    'bazy-danych-lab',
    'lab-3-sieci',
    'src',
    'logo.png',
    'Makefile',
    'so-projekt-shell'
  ]);
  const listed = (await mockState(request)).log.filter((l) => l.path === 'list').map((l) => l.p);
  expect(listed).toEqual(['', 'studia', 'studia/lab-3-sieci']);
});

test('opens a file in Monaco with highlighting, breadcrumb and status bar', async ({ page }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main(void)');
  await expect(page.locator('.tab__name')).toHaveText(['main.c']);
  await expect(page.locator('.breadcrumb')).toHaveText(/studia\s*›\s*lab-3-sieci\s*›\s*src\s*›\s*main\.c/);
  await expect(page.locator('.statusbar')).toContainText('Ln 1, Kol 1');
  await expect(page.locator('.statusbar__language')).toHaveText('c');
  expect(await page.locator('.monaco-editor .view-lines span[class*="mtk"]').count()).toBeGreaterThan(3);
  await expect(page.locator('.monaco-editor .line-numbers').first()).toBeVisible();
});

test('edits are saved with Ctrl+S', async ({ page, request }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// edited\n');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  await expect(page.locator('.statusbar__unsaved')).toHaveText('Niezapisane: 1');

  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab__dirty')).toHaveCount(0);
  const state = await mockState(request);
  expect(state.files[MAIN]).toMatch(/^\/\/ edited\n#include/);
  expect(state.log.filter((l) => l.path === 'write').every((l) => l.xsrf)).toBe(true);
});

test('a save conflict can be resolved by reloading or overwriting', async ({ page, request }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');

  await setFile(request, MAIN, '// changed on disk\n');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('x');
  await page.keyboard.press('Control+s');
  const banner = page.locator('.banner', { hasText: 'zmienił się na dysku' });
  await expect(banner).toBeVisible();
  expect((await mockState(request)).files[MAIN]).toBe('// changed on disk\n');

  await banner.getByRole('button', { name: 'Wczytaj z dysku' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await editorText(page)).trim()).toBe('// changed on disk'); // Monaco renders in the next frame

  await setFile(request, MAIN, '// changed again\n');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('mine');
  await page.keyboard.press('Control+s');
  await banner.getByRole('button', { name: 'Nadpisz moją wersją' }).click();
  await expect(banner).toHaveCount(0);
  expect((await mockState(request)).files[MAIN]).toBe('// changed on disk\nmine');
});

test('tabs keep their own unsaved text; binary files show an error', async ({ page }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await treeRow(page, 'parser.c').click();
  await expectEditorToContain(page, 'int parse');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('Z');

  await page.locator('.tab__name', { hasText: 'main.c' }).click();
  await expectEditorToContain(page, 'int main');
  await page.locator('.tab__name', { hasText: 'parser.c' }).click();
  await expectEditorToContain(page, 'Z');

  await treeRow(page, 'logo.png').click();
  await expect(page.locator('.message')).toContainText('plik binarny');
});

test('closing a dirty tab and logging out ask for confirmation', async ({ page, request }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('unsaved');

  page.once('dialog', (d) => d.dismiss());
  await page.locator('.tab', { hasText: 'main.c' }).locator('.tab__close').click();
  await expect(page.locator('.tab')).toHaveCount(1);

  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  expect((await mockState(request)).files[MAIN]).not.toContain('unsaved');
});
