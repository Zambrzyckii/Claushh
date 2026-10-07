import { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import {
  MAIN,
  activeTerminal,
  expectEditorToContain,
  expectTerminalToContain,
  login,
  mockState,
  openFile,
  openRepo,
  openTerminalTab,
  resetMock,
  showView,
  terminalInputs,
  treeRow,
  typeInTerminal
} from './helpers';

/**
 * The VS Code layout on a desktop (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the title bar, the side bar and its
 * views, the bottom panel and the status bar.
 */

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

/** Drags the edge named `name` with the mouse to the point (x, y) of the page, in ten steps. */
async function dragEdgeTo(page: Page, name: string, x: number, y: number): Promise<void> {
  const box = (await page.getByRole('separator', { name }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

/** Drags the edge named `name` with the mouse by `dx` and `dy` pixels. */
async function dragEdge(page: Page, name: string, dx: number, dy: number): Promise<void> {
  const box = (await page.getByRole('separator', { name }).boundingBox())!;
  await dragEdgeTo(page, name, box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
}

/** The rendered size of a locator's element, in whole pixels. */
async function sizeOf(locator: Locator): Promise<{ width: number; height: number }> {
  const box = (await locator.boundingBox())!;
  return { width: Math.round(box.width), height: Math.round(box.height) };
}

test('the side bar hides and comes back with its expanded folder', async ({ page }) => {
  await treeRow(page, 'studia').click();
  await expect(treeRow(page, 'lab-3-sieci')).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Side bar', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.locator('app-side-bar')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(treeRow(page, 'lab-3-sieci')).toBeVisible();
});

test('the panel starts closed, and the terminal opens only when it is shown', async ({ page, request }) => {
  await expect(page.locator('section.bottom')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Panel', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('app-console-panel')).toContainText('Empty conversation'); // the page has settled
  expect((await mockState(request)).terminals).toHaveLength(0);

  await openTerminalTab(page);
  await expect(page.getByRole('tab', { name: 'TERMINAL' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await mockState(request)).terminals.length).toBe(1);
});

test('the account menu shows the user, opens Security and closes on Esc', async ({ page }) => {
  const account = page.getByRole('button', { name: 'Account: owner' });
  await account.click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu).toContainText('owner');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await account.click();
  await menu.getByRole('menuitem', { name: 'Security…' }).click();
  await expect(page.getByRole('dialog', { name: 'Security' })).toBeVisible();
});

test('an open account menu covers the panel edges: a drag on one closes the menu and resizes nothing', async ({ page }) => {
  const edge = page.getByRole('separator', { name: 'Resize side bar' });
  await expect(edge).toHaveAttribute('aria-valuenow', '240');
  await page.getByRole('button', { name: 'Account: owner' }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu).toBeVisible();

  await dragEdge(page, 'Resize side bar', 100, 0);
  await expect(menu).toHaveCount(0);
  await expect(edge).toHaveAttribute('aria-valuenow', '240');
});

test('the command centre names the repository and its branch and shows Source Control', async ({ page }) => {
  await expect(page.locator('.topbar__path')).toHaveText('projects directory');
  await openRepo(page, 'lab-3-sieci');
  await showView(page, 'Explorer');
  await page.locator('.topbar__path').click();
  await expect(page.locator('app-side-bar').getByRole('tab', { name: 'Source Control' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.topbar__path')).toHaveText(/Studia\s*\/\s*lab-3-sieci\s*main/);
});

test('Source Control lists the changes of the open repository and opens one with its changes', async ({ page }) => {
  await openRepo(page, 'lab-3-sieci');
  await openFile(page, 'src/main.c');
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// zmiana\n');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab__dirty')).toHaveCount(0);
  await page.locator('.tab', { hasText: 'main.c' }).locator('.tab__close').click();

  await showView(page, 'Source Control');
  const change = page.locator('.scm-change', { hasText: 'main.c' });
  await expect(change.locator('.scm-change__mark')).toHaveText('M');
  await expect(page.locator('app-side-bar').getByRole('tab', { name: 'Source Control' }).locator('.badge')).toHaveText('1');
  await change.click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
});

test('OPEN EDITORS lists the open files, marks the active and the unsaved one, and closes them', async ({ page }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await treeRow(page, 'parser.c').click();
  await expectEditorToContain(page, 'int parse');
  const section = page.locator('app-open-editors');
  await section.getByRole('button', { name: 'Open Editors' }).click();
  const rows = section.locator('.open-editor');
  await expect(rows.locator('.open-editor__file')).toHaveText(['main.c', 'parser.c']);
  await expect(rows.nth(1)).toHaveClass(/open-editor--active/);

  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('Z');
  await expect(rows.nth(1)).toHaveClass(/open-editor--dirty/);
  await rows.nth(0).locator('.open-editor__name').click();
  await expect(rows.nth(0)).toHaveClass(/open-editor--active/);

  page.once('dialog', (dialog) => dialog.dismiss());
  await section.getByRole('button', { name: 'Close editor parser.c' }).click();
  await expect(rows).toHaveCount(2);
  await section.getByRole('button', { name: 'Close editor main.c' }).click();
  await expect(rows.locator('.open-editor__file')).toHaveText(['parser.c']);
  await expect(page.locator('.tab__name')).toHaveText(['parser.c']);
});

test('the status bar shows the cursor, the indentation, the encoding, the line endings and the language', async ({ page }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  const bar = page.locator('.statusbar');
  await expect(bar).toContainText('Ln 1, Col 1');
  await expect(page.locator('.statusbar__indent')).toHaveText('Spaces: 4');
  await expect(bar).toContainText('UTF-8');
  await expect(page.locator('.statusbar__eol')).toHaveText('LF');
  await expect(page.locator('.statusbar__language')).toHaveText('C');
  await treeRow(page, 'Makefile').click();
  await expect(page.locator('.statusbar__indent')).toHaveText('Tab Size: 4');
});

test('the editor shows a minimap on a desktop, and the changes are an editor action', async ({ page }) => {
  await openRepo(page, 'lab-3-sieci');
  await openFile(page, 'src/main.c');
  await expectEditorToContain(page, 'int main');
  await expect(page.locator('.monaco-editor .minimap').first()).toBeVisible();
  const action = page.getByRole('toolbar', { name: 'Editor actions' }).getByRole('button', { name: 'Show changes' });
  await expect(action).toHaveAttribute('aria-pressed', 'false');
  await action.click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide changes' })).toHaveAttribute('aria-pressed', 'true');
});

test('Ctrl+Alt+B hides the console from the editor, shows it with the focus in the prompt, and gives the focus back', async ({ page }) => {
  await openFile(page, MAIN);
  await expectEditorToContain(page, 'int main');
  await page.locator('.monaco-editor .view-lines').click();
  const toggle = page.getByRole('button', { name: 'Console', exact: true });
  await expect(toggle).toHaveAttribute('title', 'Console (Ctrl+Alt+B)');

  await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.console')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.tab__dirty')).toHaveCount(0);

  await page.keyboard.press('Control+Alt+b');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Hide console' })).toHaveAttribute('title', 'Hide console (Ctrl+Alt+B)');

  await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.console')).toHaveCount(0);
  await page.keyboard.type('Z');
  await expect(page.locator('.tab__dirty')).toHaveCount(1);
});

test('Ctrl+Alt+B works in the terminal, never reaches the shell, and gives the focus back to the terminal', async ({ page, request }) => {
  await openTerminalTab(page);
  await activeTerminal(page).locator('.xterm-screen').click();

  await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.console')).toHaveCount(0);
  await page.keyboard.press('Control+Alt+b');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.console')).toHaveCount(0);

  await page.keyboard.type('ls');
  await expect.poll(() => terminalInputs(request)).toBe('ls');
});

test('dragging the edge of the side bar widens it, and a double-click brings back 240 px', async ({ page }) => {
  const edge = page.getByRole('separator', { name: 'Resize side bar' });
  await expect(edge).toHaveAttribute('aria-valuenow', '240');
  await dragEdge(page, 'Resize side bar', 100, 0);
  await expect(edge).toHaveAttribute('aria-valuenow', '340');
  expect((await sizeOf(page.locator('app-side-bar'))).width).toBe(340);
  await edge.dblclick();
  await expect(edge).toHaveAttribute('aria-valuenow', '240');
  expect((await sizeOf(page.locator('app-side-bar'))).width).toBe(240);
});

test('the edge of the console stops at its minimum and at the minimum of the editor', async ({ page }) => {
  const edge = page.getByRole('separator', { name: 'Resize console' });
  await dragEdge(page, 'Resize console', -100, 0);
  await expect(edge).toHaveAttribute('aria-valuenow', '520');
  await dragEdgeTo(page, 'Resize console', 1430, 450);
  await expect(edge).toHaveAttribute('aria-valuenow', '320');
  expect((await sizeOf(page.locator('aside.console'))).width).toBe(320);
  await expect(page.getByRole('button', { name: 'Send' })).toBeInViewport({ ratio: 1 });
  await dragEdgeTo(page, 'Resize console', 10, 450);
  // 1440 - 240 (the side bar) - 240 (the editor's minimum)
  await expect(edge).toHaveAttribute('aria-valuenow', '960');
  expect((await sizeOf(page.locator('aside.console'))).width).toBe(960);
});

test('dragging the edge of the panel makes it taller, and the terminal gets one new size per drag', async ({ page, request }) => {
  await openTerminalTab(page);
  await expect.poll(async () => (await mockState(request)).terminals[0]?.sizes.length ?? 0).toBeGreaterThan(1);
  await typeInTerminal(page, 'pwd');
  await expectTerminalToContain(page, '/srv/projects');
  const before = (await mockState(request)).terminals[0].sizes;

  const edge = page.getByRole('separator', { name: 'Resize panel' });
  await expect(edge).toHaveAttribute('aria-valuenow', '232');
  await dragEdge(page, 'Resize panel', 0, -100);
  await expect(edge).toHaveAttribute('aria-valuenow', '332');
  expect((await sizeOf(page.locator('section.bottom'))).height).toBe(332);
  await expect.poll(async () => (await mockState(request)).terminals[0].sizes.length).toBe(before.length + 1);
  expect((await mockState(request)).terminals[0].sizes.at(-1)![1]).toBeGreaterThan(before.at(-1)![1]);

  const center = await sizeOf(page.locator('.center'));
  await dragEdgeTo(page, 'Resize panel', 700, 50);
  await expect(edge).toHaveAttribute('aria-valuenow', String(center.height - 120));
  await dragEdgeTo(page, 'Resize panel', 700, 890);
  await expect(edge).toHaveAttribute('aria-valuenow', '120');
});

test('the edges move with the keyboard', async ({ page }) => {
  const side = page.getByRole('separator', { name: 'Resize side bar' });
  await side.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(side).toHaveAttribute('aria-valuenow', '260');
  await page.keyboard.press('ArrowLeft');
  await expect(side).toHaveAttribute('aria-valuenow', '250');
  await page.keyboard.press('End');
  // 1440 - 420 (the console) - 240 (the editor's minimum)
  await expect(side).toHaveAttribute('aria-valuenow', '780');
  await expect(side).toHaveAttribute('aria-valuemin', '170');
  await expect(side).toHaveAttribute('aria-valuemax', '780');
  await page.keyboard.press('Home');
  await expect(side).toHaveAttribute('aria-valuenow', '170');

  // the side bar at its minimum leaves the console room to grow
  const consoleEdge = page.getByRole('separator', { name: 'Resize console' });
  await consoleEdge.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(consoleEdge).toHaveAttribute('aria-valuenow', '430');
});

test('a narrower window takes the room from the console first, and a wider one gives it back', async ({ page }) => {
  const side = page.getByRole('separator', { name: 'Resize side bar' });
  const consoleEdge = page.getByRole('separator', { name: 'Resize console' });
  await page.setViewportSize({ width: 850, height: 900 });
  // 850 - 240 (the side bar) - 240 (the editor's minimum)
  await expect(consoleEdge).toHaveAttribute('aria-valuenow', '370');
  await expect(side).toHaveAttribute('aria-valuenow', '240');
  await page.setViewportSize({ width: 780, height: 900 });
  // the console at its minimum, then 780 - 320 - 240 for the side bar
  await expect(consoleEdge).toHaveAttribute('aria-valuenow', '320');
  await expect(side).toHaveAttribute('aria-valuenow', '220');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(consoleEdge).toHaveAttribute('aria-valuenow', '420');
  await expect(side).toHaveAttribute('aria-valuenow', '240');
});

test('a panel has an edge only while it is open', async ({ page }) => {
  const side = page.getByRole('separator', { name: 'Resize side bar' });
  const panel = page.getByRole('separator', { name: 'Resize panel' });
  const consoleEdge = page.getByRole('separator', { name: 'Resize console' });
  await expect(side).toHaveCount(1);
  await expect(consoleEdge).toHaveCount(1);
  await expect(panel).toHaveCount(0); // the panel starts closed
  await page.getByRole('button', { name: 'Panel', exact: true }).click();
  await expect(panel).toHaveCount(1);
  await page.getByRole('button', { name: 'Side bar', exact: true }).click();
  await page.getByRole('button', { name: 'Console', exact: true }).click();
  await expect(side).toHaveCount(0);
  await expect(consoleEdge).toHaveCount(0);
});
