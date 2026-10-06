import { expect, test } from './fixtures';
import { expectEditorToContain, login, mockState, resetMock, searchFor, showView } from './helpers';

/**
 * Search in files on a desktop (docs/ARCHITECTURE.md, "Frontend" → "Layout"; contract: "Search API contract"): the Search
 * view of the side bar on the mock's files.
 */

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

test('a search groups its matches by file with counts and highlights them', async ({ page }) => {
  const view = await searchFor(page, 'main');
  await expect(view.locator('.message')).toHaveText('3 results in 3 files');
  await expect(view.locator('.search-file__name')).toHaveText(['Makefile', 'main.c', 'shell.c']);
  await expect(view.locator('.search-file__dir')).toHaveText(['studia/lab-3-sieci', 'studia/lab-3-sieci/src', 'studia/so-projekt-shell/src']);
  await expect(view.locator('.search-file .badge')).toHaveText(['1', '1', '1']);
  await expect(view.locator('.search-match .hit')).toHaveText(['main', 'main', 'main']);
  await expect(view.locator('.search-match').nth(1)).toHaveText('int main(void)');
});

test('a click on a result opens the file at the match', async ({ page }) => {
  const view = await searchFor(page, 'main');
  await view.locator('.search-match', { hasText: 'cc -o app' }).click();
  await expectEditorToContain(page, 'cc -o app src/main.c');
  await expect(page.locator('.tab--active .tab__name')).toHaveText('Makefile');
  // The match is selected, so the cursor stands at its end: "main" covers columns 16-19 of line 2.
  await expect(page.locator('.statusbar')).toContainText('Ln 2, Col 20');
});

test('a regular expression, whole words, no results and an unsupported pattern', async ({ page }) => {
  const view = await searchFor(page, 'pars\\w+');
  await expect(view.locator('.message')).toHaveText('No results found.');
  const regex = view.getByRole('button', { name: 'Use Regular Expression' });
  await regex.click();
  await expect(regex).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.search-match .hit')).toHaveText(['parse']);

  const field = view.getByRole('textbox', { name: 'Search', exact: true });
  await field.fill('(?<=int )main');
  await field.press('Enter');
  await expect(view.getByRole('alert')).toHaveText('Invalid or unsupported regular expression.');

  await regex.click();
  await field.fill('mai');
  await view.getByRole('button', { name: 'Match Whole Word' }).click();
  await expect(view.locator('.message')).toHaveText('No results found.');
});

test('fast typing sends one search, for the last query', async ({ page, request }) => {
  await showView(page, 'Search');
  const view = page.locator('app-search-view');
  await view.getByRole('textbox', { name: 'Search', exact: true }).pressSequentially('zadanie', { delay: 30 });
  await expect(view.locator('.search-file__name')).toHaveText(['zadanie4.sql']);
  await expect(view.locator('.message')).toHaveText('1 result in 1 file');
  expect((await mockState(request)).log.filter((entry) => entry.path === 'search')).toHaveLength(1);
});
