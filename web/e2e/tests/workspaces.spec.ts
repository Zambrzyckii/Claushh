import { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  BAZY_SQL,
  LAB,
  MAIN,
  expectEditorToContain,
  killSessions,
  fillLogin,
  login,
  mockState,
  openFile,
  openRepo,
  repoRow,
  resetMock,
  setRepoState,
  treeRow
} from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

const panel = (page: Page) => page.locator('app-workspaces-panel');
const cells = async (page: Page, name: string) =>
  (await repoRow(page, name).locator('td').allInnerTexts()).map((t) => t.trim().replace(/\s+/g, ' '));

test('lists workspaces and the repositories of the selected one', async ({ page }) => {
  await expect(panel(page).locator('.workspace')).toHaveText([/Studia\s*3 repos/, /Prywatne\s*1 repo/]);
  await expect(panel(page).locator('.repo__name')).toHaveText(['bazy-danych-lab', 'lab-3-sieci', 'so-projekt-shell']);

  const lab = await cells(page, 'lab-3-sieci');
  expect(lab.slice(0, 5)).toEqual(['lab-3-sieci', 'main', 'clean', 'parser: szkielet parse_ipv4 · 12 minutes ago', 'origin ↑1']);
  expect((await cells(page, 'bazy-danych-lab'))[4]).toBe('origin ↓2');

  await panel(page).locator('.workspace', { hasText: 'Prywatne' }).click();
  await expect(panel(page).locator('.repo__name')).toHaveText(['notatki']);
  const notes = await cells(page, 'notatki');
  expect(notes[4]).toBe('none');
  await expect(repoRow(page, 'notatki').getByRole('button', { name: 'Pull notatki' })).toBeDisabled();
});

test('opening a repository scopes the explorer, top bar, status bar and console', async ({ page }) => {
  await openRepo(page, 'lab-3-sieci');
  await expect(page).toHaveURL(`/?repo=${encodeURIComponent(LAB)}`);
  await expect(page.locator('.topbar__path')).toHaveText(/Workspace\s*\/\s*Studia\s*\/\s*lab-3-sieci\s*main/);
  await expect(page.locator('.row__name')).toHaveText(['src', 'logo.png', 'Makefile']);
  await expect(page.locator('.statusbar__branch')).toHaveText('main');
  await expect(page.locator('.statusbar__changes')).toHaveText('no changes');
  await expect(page.locator('app-console-panel')).toContainText('CONSOLE · lab-3-sieci');
  await expect(repoRow(page, 'lab-3-sieci')).toHaveClass(/repo--open/);

  await page.reload();
  await expect(page.locator('.row__name')).toHaveText(['src', 'logo.png', 'Makefile']);
  await expect(page.locator('.topbar__repo')).toHaveText('lab-3-sieci');
});

test('the open repository survives an expired session', async ({ page, request }) => {
  await openRepo(page, 'lab-3-sieci');
  await expect(page.locator('app-console-panel')).toContainText('Empty conversation');
  await killSessions(request);
  await expect(page).toHaveURL(/\/login\?reason=expired/);
  await fillLogin(page);
  await expect(page).toHaveURL(`/?repo=${encodeURIComponent(LAB)}`);
  await expect(page.locator('.topbar__repo')).toHaveText('lab-3-sieci');
});

test('saved edits and console changes show up as git changes', async ({ page }) => {
  await openRepo(page, 'lab-3-sieci');
  await openFile(page, 'src/main.c');
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// edited\n');
  await page.keyboard.press('Control+s');

  await expect(treeRow(page, 'main.c').locator('.row__mark')).toHaveText('M');
  await expect(treeRow(page, 'src').locator('.row__mark')).toHaveText('•');
  await expect(page.locator('.statusbar__changes')).toHaveText('1 change');
  await expect(repoRow(page, 'lab-3-sieci').locator('td').nth(2)).toHaveText('1 change');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('dodaj komentarz');
  await prompt.press('Enter');
  await expect(page.locator('app-console-panel')).toContainText(/edited\s+src\/main\.c/);
  await expect(treeRow(page, 'NOTES.md').locator('.row__mark')).toHaveText('U');
  await expect(page.locator('.statusbar__changes')).toHaveText('2 changes');
  await expect(repoRow(page, 'lab-3-sieci').locator('td').nth(2)).toHaveText('2 changes');
});

test('push sends local commits and reports rejections', async ({ page, request }) => {
  await repoRow(page, 'lab-3-sieci').getByRole('button', { name: 'Push lab-3-sieci' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Pushed 1 commit to origin/main.');
  await expect(repoRow(page, 'lab-3-sieci').locator('td').nth(4)).toHaveText('origin');

  // bazy-danych-lab is ahead 0 / behind 2 by default (nothing to push without the network); its own state here, so
  // the push is rejected (ahead and behind both non-zero), as the backend answers, without touching the fourth
  // repository that other tests' list order and counts pin.
  await setRepoState(request, 'studia/bazy-danych-lab', { ahead: 1 });
  await repoRow(page, 'bazy-danych-lab').getByRole('button', { name: 'Push bazy-danych-lab' }).click();
  const error = panel(page).getByRole('alert');
  await expect(error).toContainText('Push refused: the remote has newer changes. Pull first.');
  await expect(error).toContainText('[rejected]');

  expect((await mockState(request)).log.filter((l) => l.path === 'push').map((l) => l.repo)).toEqual([LAB, 'studia/bazy-danych-lab']);
});

test('pull updates files, including a clean file open in the editor', async ({ page }) => {
  await openRepo(page, 'bazy-danych-lab');
  await openFile(page, 'zadanie4.sql');
  await expectEditorToContain(page, 'SELECT 1');

  await repoRow(page, 'bazy-danych-lab').getByRole('button', { name: 'Pull bazy-danych-lab' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Pulled 2 commits.');
  await expectEditorToContain(page, 'SELECT 2');
  const row = await cells(page, 'bazy-danych-lab');
  expect(row[3]).toMatch(/^poprawki od prowadzącego · /);
  expect(row[4]).toBe('origin');
  await expect(page.locator('.statusbar__changes')).toHaveText('no changes');
});

test('pull is refused when it would overwrite local changes', async ({ page, request }) => {
  await openRepo(page, 'bazy-danych-lab');
  await openFile(page, 'zadanie4.sql');
  await expectEditorToContain(page, 'SELECT 1');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-- moje');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.statusbar__changes')).toHaveText('1 change');

  await repoRow(page, 'bazy-danych-lab').getByRole('button', { name: 'Pull bazy-danych-lab' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Pull refused');
  await expect(panel(page).getByRole('alert')).toContainText('would be overwritten');
  expect((await mockState(request)).files[BAZY_SQL]).toContain('-- moje');
});

test('creates a workspace, validating the name first', async ({ page, request }) => {
  await panel(page).getByRole('button', { name: 'New workspace' }).click();
  const name = panel(page).getByRole('textbox', { name: 'New workspace name' });
  await name.fill('../hack');
  await panel(page).getByRole('button', { name: 'Create' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('A name has up to 40 characters: letters, digits, spaces, - and _.');
  expect((await mockState(request)).log.some((l) => l.path === 'create-workspace')).toBe(false);

  await name.fill('Projekty zespołowe');
  await name.press('Enter');
  await expect(panel(page).locator('.workspace')).toHaveText([/Studia/, /Prywatne/, /Projekty zespołowe\s*0 repos/]);
  await expect(panel(page).locator('.workspace--active')).toContainText('Projekty zespołowe');
  await expect(panel(page)).toContainText('No repositories in this workspace.');
  await expect(treeRow(page, 'projekty-zespolowe')).toBeVisible();

  await panel(page).getByRole('button', { name: 'New workspace' }).click();
  await name.fill('projekty zespołowe');
  await name.press('Enter');
  await expect(panel(page).getByRole('alert')).toHaveText('A workspace with this name already exists.');
});

test('clones only https repositories without credentials', async ({ page, request }) => {
  await panel(page).getByRole('button', { name: 'Clone a repository into “Studia”' }).click();
  const url = panel(page).getByRole('textbox', { name: 'Repository URL to clone' });
  const clone = panel(page).getByRole('button', { name: 'Clone', exact: true });

  for (const [value, message] of [
    ['git@github.com:owner/projekt.git', 'Only https:// URLs are allowed.'],
    ['http://github.com/owner/projekt.git', 'Only https:// URLs are allowed.'],
    ['https://user:token@github.com/owner/projekt.git', 'The URL must not contain a user name or password.'],
    // The browser sees the host github.com, and git sees evil.example (with the login "github.com\").
    ['https://github.com\\@evil.example/owner/projekt.git', 'The URL must not contain a user name or password.']
  ]) {
    await url.fill(value);
    await clone.click();
    await expect(panel(page).getByRole('alert')).toHaveText(message);
  }
  expect((await mockState(request)).log.some((l) => l.path === 'clone')).toBe(false);

  await url.fill('https://github.com/owner/nie-istnieje.git');
  await clone.click();
  await expect(panel(page).getByRole('alert')).toContainText('Could not clone.');
  await expect(panel(page).getByRole('alert')).toContainText('Repository not found');

  await url.fill('https://github.com/owner/projekt-zespolowy.git');
  await clone.click();
  await expect(repoRow(page, 'projekt-zespolowy')).toBeVisible();
  await expect(panel(page).locator('.workspace', { hasText: 'Studia' })).toContainText('4 repos');
  await expect(panel(page).getByRole('textbox', { name: 'Repository URL to clone' })).toHaveCount(0);
});

test('each repository has its own console conversation', async ({ page }) => {
  const consolePanel = page.locator('app-console-panel');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await openRepo(page, 'lab-3-sieci');
  await prompt.fill('dodaj komentarz');
  await prompt.press('Enter');
  await expect(consolePanel).toContainText('Gotowe.');

  await openRepo(page, 'so-projekt-shell');
  await expect(consolePanel).toContainText('CONSOLE · so-projekt-shell');
  await expect(consolePanel).toContainText('Empty conversation');

  await openRepo(page, 'lab-3-sieci');
  await expect(consolePanel).toContainText('> dodaj komentarz');
  await expect(consolePanel).toContainText('Gotowe.');
});

test('tabs from another repository stay open after switching', async ({ page }) => {
  await openRepo(page, 'lab-3-sieci');
  await openFile(page, 'src/main.c');
  await expectEditorToContain(page, 'int main');
  await openRepo(page, 'so-projekt-shell');
  await expect(page.locator('.tab__name')).toHaveText(['main.c']);
  await expect(page.locator('.breadcrumb')).toContainText('lab-3-sieci');
  await expect(page.locator('.row__name')).toHaveText(['src']);
  expect(MAIN.startsWith(LAB)).toBe(true);
});
