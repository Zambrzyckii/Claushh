import { expect, test } from './fixtures';
import {
  expectEditorToContain,
  login,
  mockState,
  openFile,
  openRepo,
  openTerminalTab,
  resetMock,
  showView,
  treeRow
} from './helpers';

/**
 * The VS Code layout on a desktop (docs/ARCHITECTURE.md, "Frontend" → "Layout"): the title bar, the side bar and its
 * views, the bottom panel and the status bar.
 */

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

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
