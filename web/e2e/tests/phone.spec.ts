import { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  MAIN,
  activeTerminal,
  expectEditorToContain,
  login,
  mockState,
  openFile,
  repoRow,
  resetMock,
  setSessionTimeout,
  terminalText,
  typeInTerminal
} from './helpers';

/**
 * The phone layout (docs/ARCHITECTURE.md, "Frontend" → "Phone layout"), in the Pixel 7 project: the tabs Editor ·
 * Terminal · Console, the explorer drawer, the sheets, the menu, the condensed bars.
 */

test.beforeEach(async ({ request }) => resetMock(request));

const tab = (page: Page, name: 'Editor' | 'Terminal' | 'Console') => page.getByRole('tab', { name, exact: true });
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('a phone gets the phone layout, the login fits, and no tab scrolls sideways', async ({ page }) => {
  await page.goto('/login');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
  await expect(page.locator('#userName')).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  await login(page);
  await expect(tab(page, 'Editor')).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Editor', 'Terminal', 'Console'] as const) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    expect(await noSidewaysScroll(page)).toBe(true);
  }
  await expect(page.locator('app-phone-panes .tabbar')).not.toContainText(/claude/i);
  await expect(page.locator('.topbar')).not.toContainText(/claude/i);
});

test('the explorer drawer opens a file and closes, and Save writes it', async ({ page, request }) => {
  await login(page);
  const drawer = page.locator('nav.drawer');
  await page.getByRole('button', { name: 'Explorer' }).click();
  await expect(drawer).toHaveClass(/drawer--open/);
  await openFile(page, MAIN);
  await expect(drawer).not.toHaveClass(/drawer--open/);
  await expectEditorToContain(page, 'int main');

  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// phone\n');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  expect((await mockState(request)).files[MAIN]).toMatch(/^\/\/ phone\n#include/);
});

test('switching tabs keeps the editor and its unsaved text, and the terminal mounts once on its first visit', async ({ page, request }) => {
  await login(page);
  await page.getByRole('button', { name: 'Explorer' }).click();
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('// draft');
  await page.locator('.monaco-editor').first().evaluate((editor) => editor.setAttribute('data-probe', 'kept'));
  expect((await mockState(request)).terminals).toHaveLength(0);

  await tab(page, 'Terminal').click();
  await typeInTerminal(page, 'echo telefon');
  await expect.poll(() => terminalText(page)).toMatch(/^telefon\s*$/m);
  await tab(page, 'Console').click();
  await tab(page, 'Editor').click();

  await expect(page.locator('.monaco-editor[data-probe="kept"]')).toHaveCount(1);
  await expectEditorToContain(page, '// draft');
  await expect(page.locator('.tab__dirty')).toBeVisible();
  await tab(page, 'Terminal').click();
  await expect(activeTerminal(page).locator('.xterm-rows')).toBeVisible();
  expect((await mockState(request)).terminals).toHaveLength(1);
});

test('in the console Enter makes a new line and Send sends', async ({ page, request }) => {
  await login(page);
  await tab(page, 'Console').click();
  const panel = page.locator('app-console-panel');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.click();
  await page.keyboard.type('dodaj');
  await page.keyboard.press('Enter');
  await page.keyboard.type('komentarz');
  await expect(prompt).toHaveValue('dodaj\nkomentarz');
  expect((await mockState(request)).prompts).toHaveLength(0);

  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel).toContainText('Gotowe.');
  expect((await mockState(request)).prompts.map((sent) => sent.text)).toEqual(['dodaj\nkomentarz']);
  await expect(panel.getByRole('button', { name: 'Hide' })).toHaveCount(0);
});

test('the Workspace sheet lists repositories as cards and closes when one opens', async ({ page }) => {
  await login(page);
  await page.locator('.topbar button[aria-haspopup="dialog"]').click();
  const sheet = page.getByRole('dialog', { name: 'Workspace' });
  await expect(sheet).toBeVisible();
  expect((await sheet.boundingBox())!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expect(repoRow(page, 'lab-3-sieci')).toBeVisible();
  expect(await repoRow(page, 'lab-3-sieci').evaluate((row) => getComputedStyle(row).display)).toBe('block');

  await repoRow(page, 'lab-3-sieci').getByRole('button', { name: 'Open lab-3-sieci' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.topbar__repo')).toHaveText('lab-3-sieci');
  await expect(page.locator('.topbar__branch')).toHaveText('main');
});

test('the menu opens Security as a full-width sheet, closes on Esc, and logs out', async ({ page }) => {
  await login(page);
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: 'Security' }).click();
  const security = page.getByRole('dialog', { name: 'Security' });
  await expect(security).toBeVisible();
  expect((await security.boundingBox())!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expect(security.locator('tr.session')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(security).toBeHidden();

  await menu.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await menu.click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/login?logout=ok');
});

test('the countdown shows minutes and seconds, and Extend extends', async ({ page, request }) => {
  await setSessionTimeout(request, 100);
  await login(page);
  const timer = page.getByRole('timer');
  await expect(timer).toHaveText(/^\s*1:(3\d|40)\s*$/);
  await expect(timer).toHaveAttribute('aria-label', /^Session expires in 1:/);
  await page.getByRole('button', { name: 'Extend' }).click();
  await expect.poll(async () => (await mockState(request)).log.filter((entry) => entry.path === 'keepalive').length).toBe(1);
});

test('a phone in landscape keeps the phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 839, height: 412 });
  await login(page);
  await expect(tab(page, 'Editor')).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
});
