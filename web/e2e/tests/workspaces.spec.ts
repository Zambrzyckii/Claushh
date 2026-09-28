import { Page, expect, test } from '@playwright/test';

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
  await expect(panel(page).locator('.workspace')).toHaveText([/Studia\s*3 repo/, /Prywatne\s*1 repo/]);
  await expect(panel(page).locator('.repo__name')).toHaveText(['lab-3-sieci', 'so-projekt-shell', 'bazy-danych-lab']);

  const lab = await cells(page, 'lab-3-sieci');
  expect(lab.slice(0, 5)).toEqual(['lab-3-sieci', 'main', 'czysto', 'parser: szkielet parse_ipv4 · 12 minut temu', 'origin ↑1']);
  expect((await cells(page, 'bazy-danych-lab'))[4]).toBe('origin ↓2');

  await panel(page).locator('.workspace', { hasText: 'Prywatne' }).click();
  await expect(panel(page).locator('.repo__name')).toHaveText(['notatki']);
  const notes = await cells(page, 'notatki');
  expect(notes[4]).toBe('brak');
  await expect(repoRow(page, 'notatki').getByRole('button', { name: 'Pull notatki' })).toBeDisabled();
});

test('opening a repository scopes the explorer, top bar, status bar and console', async ({ page }) => {
  await openRepo(page, 'lab-3-sieci');
  await expect(page).toHaveURL(`/?repo=${encodeURIComponent(LAB)}`);
  await expect(page.locator('.topbar__path')).toHaveText(/Workspace\s*\/\s*Studia\s*\/\s*lab-3-sieci\s*main/);
  await expect(page.locator('.row__name')).toHaveText(['src', 'logo.png', 'Makefile']);
  await expect(page.locator('.statusbar__branch')).toHaveText('main');
  await expect(page.locator('.statusbar__changes')).toHaveText('bez zmian');
  await expect(page.locator('app-console-panel')).toContainText('KONSOLA · lab-3-sieci');
  await expect(repoRow(page, 'lab-3-sieci')).toHaveClass(/repo--open/);

  await page.reload();
  await expect(page.locator('.row__name')).toHaveText(['src', 'logo.png', 'Makefile']);
  await expect(page.locator('.topbar__repo')).toHaveText('lab-3-sieci');
});

test('the open repository survives an expired session', async ({ page, request }) => {
  await openRepo(page, 'lab-3-sieci');
  await expect(page.locator('app-console-panel')).toContainText('Pusta rozmowa');
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
  await expect(page.locator('.statusbar__changes')).toHaveText('1 zmiana');
  await expect(repoRow(page, 'lab-3-sieci').locator('td').nth(2)).toHaveText('1 zmiana');

  const prompt = page.getByRole('textbox', { name: 'Polecenie' });
  await prompt.fill('dodaj komentarz');
  await prompt.press('Enter');
  await expect(page.locator('app-console-panel')).toContainText(/edycja\s+src\/main\.c/);
  await expect(treeRow(page, 'NOTES.md').locator('.row__mark')).toHaveText('U');
  await expect(page.locator('.statusbar__changes')).toHaveText('2 zmiany');
  await expect(repoRow(page, 'lab-3-sieci').locator('td').nth(2)).toHaveText('2 zmiany');
});

test('push sends local commits and reports rejections', async ({ page, request }) => {
  await repoRow(page, 'lab-3-sieci').getByRole('button', { name: 'Push lab-3-sieci' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Wypchnięto 1 commit do origin/main.');
  await expect(repoRow(page, 'lab-3-sieci').locator('td').nth(4)).toHaveText('origin');

  await repoRow(page, 'bazy-danych-lab').getByRole('button', { name: 'Push bazy-danych-lab' }).click();
  const error = panel(page).getByRole('alert');
  await expect(error).toContainText('Push odrzucony: na zdalnym repozytorium są nowsze zmiany. Najpierw zrób Pull.');
  await expect(error).toContainText('[rejected]');

  expect((await mockState(request)).log.filter((l) => l.path === 'push').map((l) => l.repo)).toEqual([LAB, 'studia/bazy-danych-lab']);
});

test('pull updates files, including a clean file open in the editor', async ({ page }) => {
  await openRepo(page, 'bazy-danych-lab');
  await openFile(page, 'zadanie4.sql');
  await expectEditorToContain(page, 'SELECT 1');

  await repoRow(page, 'bazy-danych-lab').getByRole('button', { name: 'Pull bazy-danych-lab' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Pobrano 2 commity.');
  await expectEditorToContain(page, 'SELECT 2');
  const row = await cells(page, 'bazy-danych-lab');
  expect(row[3]).toMatch(/^poprawki od prowadzącego · /);
  expect(row[4]).toBe('origin');
  await expect(page.locator('.statusbar__changes')).toHaveText('bez zmian');
});

test('pull is refused when it would overwrite local changes', async ({ page, request }) => {
  await openRepo(page, 'bazy-danych-lab');
  await openFile(page, 'zadanie4.sql');
  await expectEditorToContain(page, 'SELECT 1');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-- moje');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.statusbar__changes')).toHaveText('1 zmiana');

  await repoRow(page, 'bazy-danych-lab').getByRole('button', { name: 'Pull bazy-danych-lab' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Pull odrzucony');
  await expect(panel(page).getByRole('alert')).toContainText('would be overwritten');
  expect((await mockState(request)).files[BAZY_SQL]).toContain('-- moje');
});

test('creates a workspace, validating the name first', async ({ page, request }) => {
  await panel(page).getByRole('button', { name: '+ Nowy workspace' }).click();
  const name = panel(page).getByRole('textbox', { name: "Nazwa nowego workspace'u" });
  await name.fill('../hack');
  await panel(page).getByRole('button', { name: 'Utwórz' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('Nazwa może mieć do 40 znaków: litery, cyfry, spacje, - i _.');
  expect((await mockState(request)).log.some((l) => l.path === 'create-workspace')).toBe(false);

  await name.fill('Projekty zespołowe');
  await name.press('Enter');
  await expect(panel(page).locator('.workspace')).toHaveText([/Studia/, /Prywatne/, /Projekty zespołowe\s*0 repo/]);
  await expect(panel(page).locator('.workspace--active')).toContainText('Projekty zespołowe');
  await expect(panel(page)).toContainText('Brak repozytoriów w tym workspace.');
  await expect(treeRow(page, 'projekty-zespolowe')).toBeVisible();

  await panel(page).getByRole('button', { name: '+ Nowy workspace' }).click();
  await name.fill('projekty zespołowe');
  await name.press('Enter');
  await expect(panel(page).getByRole('alert')).toHaveText('Workspace o tej nazwie już istnieje.');
});

test('clones only https repositories without credentials', async ({ page, request }) => {
  await panel(page).getByRole('button', { name: '+ Sklonuj repozytorium do „Studia”' }).click();
  const url = panel(page).getByRole('textbox', { name: 'Adres repozytorium do sklonowania' });
  const clone = panel(page).getByRole('button', { name: 'Klonuj' });

  for (const [value, message] of [
    ['git@github.com:owner/projekt.git', 'Nieprawidłowy adres.'],
    ['http://github.com/owner/projekt.git', 'Dozwolone są tylko adresy https://.'],
    ['https://user:token@github.com/owner/projekt.git', 'Adres nie może zawierać loginu ani hasła.']
  ]) {
    await url.fill(value);
    await clone.click();
    await expect(panel(page).getByRole('alert')).toHaveText(message);
  }
  expect((await mockState(request)).log.some((l) => l.path === 'clone')).toBe(false);

  await url.fill('https://github.com/owner/nie-istnieje.git');
  await clone.click();
  await expect(panel(page).getByRole('alert')).toContainText('Nie udało się sklonować.');
  await expect(panel(page).getByRole('alert')).toContainText('Repository not found');

  await url.fill('https://github.com/owner/projekt-zespolowy.git');
  await clone.click();
  await expect(repoRow(page, 'projekt-zespolowy')).toBeVisible();
  await expect(panel(page).locator('.workspace', { hasText: 'Studia' })).toContainText('4 repo');
  await expect(panel(page).getByRole('textbox', { name: 'Adres repozytorium do sklonowania' })).toHaveCount(0);
});

test('each repository has its own console conversation', async ({ page }) => {
  const consolePanel = page.locator('app-console-panel');
  const prompt = page.getByRole('textbox', { name: 'Polecenie' });
  await openRepo(page, 'lab-3-sieci');
  await prompt.fill('dodaj komentarz');
  await prompt.press('Enter');
  await expect(consolePanel).toContainText('Gotowe.');

  await openRepo(page, 'so-projekt-shell');
  await expect(consolePanel).toContainText('KONSOLA · so-projekt-shell');
  await expect(consolePanel).toContainText('Pusta rozmowa');

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
