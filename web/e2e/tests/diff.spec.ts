import { Page, expect, test } from '@playwright/test';

import { MAIN, expectEditorToContain, login, mockState, openFile, openRepo, resetMock } from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
  await openRepo(page, 'lab-3-sieci');
});

const side = async (page: Page, which: 'original' | 'modified') =>
  (await page.locator(`.monaco-diff-editor .editor.${which} .view-lines:not(.line-delete)`).innerText()).replace(/\u00a0/g, ' ');

test('shows changes against the last commit and keeps editing and saving', async ({ page, request }) => {
  await openFile(page, 'src/main.c');
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// zmiana\n');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab__dirty')).toHaveCount(0);

  await page.getByRole('button', { name: 'Pokaż zmiany' }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await expect.poll(() => side(page, 'modified')).toContain('// zmiana');
  await expect.poll(() => side(page, 'original')).toContain('#include <stdio.h>');
  expect(await side(page, 'original')).not.toContain('// zmiana');
  await expect(page.getByRole('button', { name: 'Ukryj zmiany' })).toHaveAttribute('aria-pressed', 'true');

  await page.locator('.monaco-diff-editor .editor.modified .view-lines:not(.line-delete)').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// w widoku zmian');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab__dirty')).toHaveCount(0);
  expect((await mockState(request)).files[MAIN]).toContain('// w widoku zmian');

  await page.getByRole('button', { name: 'Ukryj zmiany' }).click();
  await expect(page.locator('.monaco-diff-editor')).not.toBeVisible();
  await expectEditorToContain(page, '// w widoku zmian');
});

test('a file that is not in the last commit is shown as new', async ({ page }) => {
  const prompt = page.getByRole('textbox', { name: 'Polecenie' });
  await prompt.fill('dodaj komentarz');
  await prompt.press('Enter');
  await expect(page.locator('app-console-panel')).toContainText('Gotowe.');

  await openFile(page, 'NOTES.md');
  await expectEditorToContain(page, '# Notatki z konsoli');
  await page.getByRole('button', { name: 'Pokaż zmiany' }).click();
  await expect(page.locator('.breadcrumb')).toContainText('nowy plik (brak w ostatnim commicie)');
  await expect.poll(() => side(page, 'modified')).toContain('# Notatki z konsoli');
});
