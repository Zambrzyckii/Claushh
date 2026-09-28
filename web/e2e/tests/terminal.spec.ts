import { expect, test } from '@playwright/test';

import {
  MAIN,
  activeTerminal,
  expectEditorToContain,
  expectTerminalToContain,
  mockState,
  login,
  openFile,
  openRepo,
  openTerminalTab,
  resetMock,
  terminalText,
  typeInTerminal
} from './helpers';

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

const tabs = (page: import('@playwright/test').Page) => page.locator('app-terminal-panel .tab__name');

test('the first terminal opens in the open repository and runs commands', async ({ page, request }) => {
  await openRepo(page, 'lab-3-sieci');
  await openTerminalTab(page);
  await expect(tabs(page)).toHaveText(['lab-3-sieci']);
  await expectTerminalToContain(page, 'owner@dom:~/projekty/studia/lab-3-sieci$');

  await typeInTerminal(page, 'pwd');
  await expectTerminalToContain(page, '/srv/projects/studia/lab-3-sieci');
  await typeInTerminal(page, 'ls');
  await expectTerminalToContain(page, 'Makefile  logo.png  src');

  const [terminal] = (await mockState(request)).terminals;
  expect(terminal.cwd).toBe('studia/lab-3-sieci');
  const [cols, rows] = terminal.sizes.at(-1)!;
  expect(cols).toBeGreaterThan(100);
  expect(rows).toBeGreaterThanOrEqual(5);
});

test('editing keys reach the shell: backspace and Ctrl+C', async ({ page }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'pwdx', false);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page)).toMatch(/^\/srv\/projects\s*$/m);

  await typeInTerminal(page, 'sleep 100', false);
  await page.keyboard.press('Control+c');
  await expectTerminalToContain(page, 'sleep 100^C');
});

test('a terminal survives a page reload without duplicated output', async ({ page, request }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'echo zachowane');
  await expect.poll(async () => (await terminalText(page)).match(/zachowane/g)?.length).toBe(2);

  await page.reload();
  await openTerminalTab(page);
  await expect(tabs(page)).toHaveText(['projekty']);
  await expect.poll(async () => (await terminalText(page)).match(/zachowane/g)?.length).toBe(2);
  expect((await mockState(request)).terminals).toHaveLength(1);

  await page.getByRole('tab', { name: 'WORKSPACE' }).click();
  await openTerminalTab(page);
  await expect.poll(async () => (await terminalText(page)).match(/zachowane/g)?.length).toBe(2);
});

test('several terminals can be opened, switched and closed', async ({ page, request }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'echo pierwszy');
  await expectTerminalToContain(page, 'pierwszy');

  await page.getByRole('button', { name: '+ Nowy' }).click();
  await expect(tabs(page)).toHaveText(['projekty', 'projekty (2)']);
  await expect(activeTerminal(page).locator('.xterm-rows')).toBeVisible();
  await expect.poll(() => terminalText(page)).not.toContain('pierwszy');

  await tabs(page).first().click();
  await expectTerminalToContain(page, 'pierwszy');

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Zamknij terminal projekty (2)' }).click();
  await expect(tabs(page)).toHaveCount(2);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Zamknij terminal projekty (2)' }).click();
  await expect(tabs(page)).toHaveText(['projekty']);
  expect((await mockState(request)).log.filter((l) => l.path === 'terminal-close')).toHaveLength(1);
});

test('exit ends the shell and the tab closes without asking', async ({ page }) => {
  await openTerminalTab(page);
  await typeInTerminal(page, 'exit');
  await expectTerminalToContain(page, '[proces zakończony]');
  await expect(tabs(page)).toHaveText(['projekty (zakończony)']);

  let asked = false;
  page.once('dialog', (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Zamknij terminal projekty' }).click();
  await expect(tabs(page)).toHaveCount(0);
  expect(asked).toBe(false);
  await expect(page.locator('app-terminal-panel')).toContainText('Brak otwartych terminali.');
});

test('Ctrl+S inside the terminal goes to the shell, not to the editor', async ({ page, request }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('// niezapisane');
  await expect(page.locator('.tab__dirty')).toBeVisible();

  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await mockState(request)).terminals[0].inputs).toContain('\x13');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  expect((await mockState(request)).files[MAIN]).not.toContain('niezapisane');
});

test('the terminal follows layout changes', async ({ page, request }) => {
  await openTerminalTab(page);
  await expect.poll(async () => (await mockState(request)).terminals[0]?.sizes.length ?? 0).toBeGreaterThan(1);
  const before = (await mockState(request)).terminals[0].sizes.at(-1)![0];

  await page.setViewportSize({ width: 1000, height: 900 });
  await expect.poll(async () => (await mockState(request)).terminals[0].sizes.at(-1)![0]).toBeLessThan(before);
});
